// End-to-end test of the opportunity owner/editor row-level security patch.
// Runs against a server started by e2e/run.sh: light dev seed, where Tim is
// admin and Jony / Jane are members. Uses the public GraphQL API only.
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3300';
const PASSWORD = 'tim@apple.dev'; // every dev seed user has this password

// WORKSPACE_MEMBER_DATA_SEED_IDS in Twenty's dev seeder
const MEMBERS = {
  tim: '20202020-0687-4c41-b707-ed1bfca972a7',
  jony: '20202020-77d5-4cb6-b60a-f4a835a85d61',
  jane: '20202020-463f-435b-828c-107e007a2711',
};

const request = async (path, query, variables = {}, token) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
};

const ok = (result) => {
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return result.data;
};

const login = async (email) => {
  const { getLoginTokenFromCredentials } = ok(
    await request(
      '/metadata',
      `mutation ($email: String!, $password: String!, $origin: String!) {
        getLoginTokenFromCredentials(email: $email, password: $password, origin: $origin) { loginToken { token } }
      }`,
      { email, password: PASSWORD, origin: BASE_URL },
    ),
  );
  const { getAuthTokensFromLoginToken } = ok(
    await request(
      '/metadata',
      `mutation ($loginToken: String!, $origin: String!) {
        getAuthTokensFromLoginToken(loginToken: $loginToken, origin: $origin) { tokens { accessOrWorkspaceAgnosticToken { token } } }
      }`,
      { loginToken: getLoginTokenFromCredentials.loginToken.token, origin: BASE_URL },
    ),
  );
  return getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
};

const gql = (token) => (query, variables) => request('/graphql', query, variables, token);
const metadata = (token) => (query, variables) => request('/metadata', query, variables, token);

const OPPORTUNITY_IDS = `query ($filter: OpportunityFilterInput) {
  opportunities(filter: $filter, first: 200) { edges { node { id } } }
}`;
const NOTE_IDS = `query ($filter: NoteFilterInput) {
  notes(filter: $filter, first: 200) { edges { node { id } } }
}`;

const ids = (connection) => connection.edges.map(({ node }) => node.id);

const visibleOpportunityIds = async (client, filter) =>
  ids(ok(await client(OPPORTUNITY_IDS, { filter })).opportunities);

const createOpportunity = async (client, name, ownerId) =>
  ok(
    await client(
      `mutation ($data: OpportunityCreateInput!) { createOpportunity(data: $data) { id } }`,
      { data: { name, ownerId } },
    ),
  ).createOpportunity.id;

const createNote = async (client, title) =>
  ok(
    await client(`mutation ($data: NoteCreateInput!) { createNote(data: $data) { id } }`, {
      data: { title },
    }),
  ).createNote.id;

const createNoteTarget = (client, noteId, targetOpportunityId) =>
  client(`mutation ($data: NoteTargetCreateInput!) { createNoteTarget(data: $data) { id } }`, {
    data: { noteId, targetOpportunityId },
  });

const run = Date.now();
const as = {};
const opp = {};

before(async () => {
  for (const [name, email] of [
    ['tim', 'tim@apple.dev'],
    ['jony', 'jony.ive@apple.dev'],
    ['jane', 'jane.austen@apple.dev'],
  ]) {
    as[name] = gql(await login(email));
  }
  as.timMetadata = metadata(await login('tim@apple.dev'));

  opp.jony = await createOpportunity(as.tim, `e2e ${run} owned by Jony`, MEMBERS.jony);
  opp.tim = await createOpportunity(as.tim, `e2e ${run} owned by Tim`, MEMBERS.tim);
});

describe('opportunity visibility', () => {
  test('admin sees every opportunity', async () => {
    const visible = await visibleOpportunityIds(as.tim);
    assert.ok(visible.includes(opp.jony));
    assert.ok(visible.includes(opp.tim));
  });

  test('member only sees opportunities they own', async () => {
    const visible = await visibleOpportunityIds(as.jony);
    assert.ok(visible.includes(opp.jony));
    assert.ok(!visible.includes(opp.tim));
    const all = ok(
      await as.jony(`{ opportunities(first: 200) { edges { node { id ownerId } } } }`),
    ).opportunities.edges;
    assert.ok(all.every(({ node }) => node.ownerId === MEMBERS.jony));
  });

  test('member cannot read an inaccessible opportunity by id', async () => {
    assert.deepEqual(await visibleOpportunityIds(as.jony, { id: { eq: opp.tim } }), []);
  });

  test('member cannot update an inaccessible opportunity', async () => {
    await as.jony(
      `mutation ($id: UUID!) { updateOpportunity(id: $id, data: { name: "hijacked" }) { id } }`,
      { id: opp.tim },
    );
    const { opportunity } = ok(
      await as.tim(`query ($id: UUID!) { opportunity(filter: { id: { eq: $id } }) { name } }`, {
        id: opp.tim,
      }),
    );
    assert.equal(opportunity.name, `e2e ${run} owned by Tim`);
  });
});

describe('records linked to opportunities', () => {
  test('member cannot attach a note to an inaccessible opportunity', async () => {
    const noteId = await createNote(as.jony, `e2e ${run} jony note`);
    const denied = await createNoteTarget(as.jony, noteId, opp.tim);
    assert.ok(denied.errors?.length, 'expected the note target to be rejected');
    ok(await createNoteTarget(as.jony, noteId, opp.jony));
  });

  test('member cannot see notes of an inaccessible opportunity', async () => {
    const hiddenNote = await createNote(as.tim, `e2e ${run} note on Tim's opportunity`);
    ok(await createNoteTarget(as.tim, hiddenNote, opp.tim));
    const visibleNote = await createNote(as.tim, `e2e ${run} note on Jony's opportunity`);
    ok(await createNoteTarget(as.tim, visibleNote, opp.jony));

    const filter = { id: { in: [hiddenNote, visibleNote] } };
    assert.deepEqual(ids(ok(await as.jony(NOTE_IDS, { filter })).notes), [visibleNote]);
    assert.equal(ids(ok(await as.tim(NOTE_IDS, { filter })).notes).length, 2);
  });
});

describe('editors junction', () => {
  const objectId = async (nameSingular) => {
    const { objects } = ok(
      await as.timMetadata(`{ objects(paging: { first: 500 }) { edges { node { id nameSingular } } } }`),
    );
    return objects.edges.find(({ node }) => node.nameSingular === nameSingular)?.node.id;
  };

  const createManyToOne = async (objectMetadataId, name, label, targetObjectMetadataId, targetFieldLabel) =>
    ok(
      await as.timMetadata(
        `mutation ($input: CreateOneFieldMetadataInput!) { createOneField(input: $input) { id } }`,
        {
          input: {
            field: {
              objectMetadataId,
              type: 'RELATION',
              name,
              label,
              icon: 'IconLink',
              relationCreationPayload: {
                type: 'MANY_TO_ONE',
                targetObjectMetadataId,
                targetFieldLabel,
                targetFieldIcon: 'IconUsers',
              },
            },
          },
        },
      ),
    );

  before(async () => {
    if (!(await objectId('opportunityEditor'))) {
      const { createOneObject } = ok(
        await as.timMetadata(
          `mutation ($input: CreateOneObjectInput!) { createOneObject(input: $input) { id } }`,
          {
            input: {
              object: {
                nameSingular: 'opportunityEditor',
                namePlural: 'opportunityEditors',
                labelSingular: 'Opportunity Editor',
                labelPlural: 'Opportunity Editors',
                icon: 'IconUsers',
              },
            },
          },
        ),
      );
      await createManyToOne(createOneObject.id, 'opportunity', 'Opportunity', await objectId('opportunity'), 'Editors');
      await createManyToOne(
        createOneObject.id,
        'workspaceMember',
        'Workspace Member',
        await objectId('workspaceMember'),
        'Opportunity Editors',
      );
    }
    // The GraphQL schema is rebuilt from the new metadata on the next request
    ok(
      await as.tim(
        `mutation ($data: OpportunityEditorCreateInput!) { createOpportunityEditor(data: $data) { id } }`,
        { data: { opportunityId: opp.tim, workspaceMemberId: MEMBERS.jane } },
      ),
    );
  });

  test('editor sees the opportunity, other members still do not', async () => {
    assert.ok((await visibleOpportunityIds(as.jane)).includes(opp.tim));
    assert.ok(!(await visibleOpportunityIds(as.jony)).includes(opp.tim));
  });

  test('member cannot add themselves as editor of an inaccessible opportunity', async () => {
    const denied = await as.jony(
      `mutation ($data: OpportunityEditorCreateInput!) { createOpportunityEditor(data: $data) { id } }`,
      { data: { opportunityId: opp.tim, workspaceMemberId: MEMBERS.jony } },
    );
    assert.ok(denied.errors?.length, 'expected the editor row to be rejected');
    assert.ok(!(await visibleOpportunityIds(as.jony)).includes(opp.tim));
  });

  test('editor can add another editor', async () => {
    ok(
      await as.jane(
        `mutation ($data: OpportunityEditorCreateInput!) { createOpportunityEditor(data: $data) { id } }`,
        { data: { opportunityId: opp.tim, workspaceMemberId: MEMBERS.jony } },
      ),
    );
    assert.ok((await visibleOpportunityIds(as.jony)).includes(opp.tim));
  });
});
