# twenty-azure

Custom Docker images for Twenty CRM with support for single-tenant / custom Azure AD (Microsoft OAuth) authentication.

By default, Twenty CRM hardcodes `tenant: 'common'`, which causes Azure AD single-tenant app registrations to fail with `AADSTS50194`. This image patches `microsoft.auth.strategy.js` to support `AUTH_MICROSOFT_TENANT_ID`.

## Image Variants

| Variant | Base Image | Context | Image Tags |
|---|---|---|---|
| **v1** | `twentycrm/twenty:v1` | `./v1` | `ghcr.io/<repo>:v1` |
| **v2** | `twentycrm/twenty:vX.Y.Z` (the release `v2` points to) | `./v2` | `ghcr.io/<repo>:vX.Y.Z`, `:vX.Y`, `:v2`, `:latest` |

The v2 image follows upstream's tags. CI looks up which `vX.Y.Z` tag on Docker Hub has the same digest as `twentycrm/twenty:v2`, builds from that exact release, runs the e2e test, and only then publishes it under the same tags. It runs on every push to `main` and every 6 hours, so new upstream releases are picked up automatically (scheduled runs skip releases already published). Pin a deployment to `ghcr.io/<repo>:vX.Y.Z` to control when upgrades happen.

## Environment Variables

```env
AUTH_MICROSOFT_ENABLED=true
AUTH_MICROSOFT_CLIENT_ID=your_client_id
AUTH_MICROSOFT_CLIENT_SECRET=your_client_secret
AUTH_MICROSOFT_CALLBACK_URL=https://your-domain.com/auth/microsoft/redirect
AUTH_MICROSOFT_TENANT_ID=your-azure-ad-tenant-id
```

## Opportunity Row-Level Security (v2 only)

`v2/build-row-access-policy.util.js` wraps Twenty's `buildRowAccessPolicy`. `WorkspaceRepository` calls it for the main table and every joined table of select/update/delete queries. The original is kept as `.orig.js` and decides first, so role permissions, built-in RLS and record sharing still apply. The patch only narrows the result further, using plain SQL on existing tables, with no DB migration.

Unless one of the caller's roles has `canUpdateAllSettings` (admins; checked live against `core.role`):

| Object | Visible / editable when |
|---|---|
| `opportunity` | the current workspace member is the `owner` or one of the `editors` |
| `noteTarget`, `taskTarget`, `attachment`, `timelineActivity`, editor junction rows | not linked to an opportunity, or linked to an accessible one |
| `note`, `task` | not linked to any inaccessible opportunity |

Creating or re-pointing a related record (a note target, attachment or editor row) requires update access to its opportunity. So members can't link records to, or add themselves as editors of, opportunities they can't access. Owners and existing editors can add or remove editors.

### Setup: multiple editors

`owner` already exists. Editors go through a junction object, which is created as metadata in the UI:

1. **Settings → Data model → + New object**: `Opportunity Editor` (API name `opportunityEditor`).
2. On it, add a **Relation** field `opportunity` → *Opportunities* (many editor rows to one opportunity), and name the reverse field on Opportunities **`editors`**.
3. On it, add a **Relation** field `workspaceMember` → *Workspace Members* (many editor rows to one member).
4. Optional: to pick members directly in the Editors field, open *Settings → Data model → Opportunities → Fields → editors → Advanced*. Turn on **This is a relation to a Junction Object** and set **Target relation on Junction Object** to the member relation from step 3. Since v2.45 this needs no Lab feature flag.

The patch finds the member relation from the junction settings, or else from the first relation on the junction object that points to *Workspace Members*. So step 4 only changes how editors appear in the UI.

### Checking the setup

Run `scripts/check-rls-setup.sh` from the directory with the deployment's compose file. It checks that:

- `server` and `worker` run a patched image, and the patch works with that Twenty release
- RLS is enabled, and the logs have no `[rls-opportunity]` errors
- in every workspace, each field in `RLS_OPPORTUNITY_MEMBER_FIELDS` resolves the way the patch expects, and the junction table has its columns

It then lists the admin users (they see every opportunity) and the opportunities without an owner. It exits 1 if anything would stop RLS from working. Service names and database credentials can be overridden; see the top of the script.

```bash
scripts/check-rls-setup.sh
COMPOSE="docker compose -f compose.prod.yml" SERVER_SERVICES="twenty-server" scripts/check-rls-setup.sh
```

```env
RLS_OPPORTUNITY_ENABLED=true                # set to false to turn it off
RLS_OPPORTUNITY_MEMBER_FIELDS=owner,editors # opportunity fields that grant access: relations to
                                            # Workspace Members, or one-to-many to a junction object
```

Notes / known gaps:
- API keys with a non-admin role see no opportunities, because they have no workspace member.
- Event gates (realtime pushes, webhooks, database-event workflow/logic-function triggers) check record snapshots in memory, where the SQL above can't run. For opportunities and their linked records they only admit roles with access to all records, so those events don't fire for other roles.
- The patch builds on the `v2` policy format (an expression tree with a `roleFilter` node that carries SQL). If an upstream `v2` rebuild changes that format again, opportunity queries fail with errors like `Cannot read properties of undefined (reading 'kind')`.
- The write check is installed by wrapping `WorkspaceRepository.prototype.resolveOwnParentLinks`. If a future `v2` build renames that method, reads are still filtered, but the write check logs `[rls-opportunity] failed to patch` at startup.

## Building Locally

```bash
# Build v1 image
docker build -t twenty-azure:v1 ./v1

# Build v2 image (optionally pin the upstream release)
docker build -t twenty-azure:v2 --build-arg TWENTY_VERSION=v2.45.0 ./v2
```

## E2E test (v2)

`e2e/run.sh` starts a throwaway Twenty stack (`e2e/compose.yml`, port 3300) with the light dev seed, where Tim is admin and Jony / Jane are members. It then runs `e2e/rls.test.mjs` against the GraphQL API, using Node 20+ with no dependencies. The test covers owner visibility, editors through an `opportunityEditor` junction it creates, linked notes, and write checks. It finishes with `scripts/check-rls-setup.sh`. The stack is removed afterwards, and server logs are kept in `e2e/server.log`.

```bash
e2e/run.sh                      # build ./v2 and test it
e2e/run.sh twenty-azure:v2      # test an existing image
```