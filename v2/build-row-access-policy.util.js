"use strict";
// Owner/editors row-level security for opportunities (twenty-azure patch).
//
// Wraps Twenty's buildRowAccessPolicy, which WorkspaceRepository calls for the
// main table and every joined table alias of select / update / delete queries.
// The original is kept as ./build-row-access-policy.util.orig.js (renamed in the
// Dockerfile) and still decides first, so role permissions, built-in RLS and
// record sharing keep working; this only narrows the result further.
//
// Unless one of the caller's roles has canUpdateAllSettings (admins), an
// opportunity is accessible when the current workspace member is referenced by
// one of RLS_OPPORTUNITY_MEMBER_FIELDS (default "owner,editors"), each being:
//   - a many-to-one relation to Workspace Member (e.g. "owner"), or
//   - a one-to-many relation to a junction object that has a many-to-one
//     relation to Workspace Member (e.g. "editors" -> opportunityEditor)
// Related records follow the opportunity:
//   - noteTarget / taskTarget / attachment / timelineActivity / junction rows:
//     their opportunity is null or accessible
//   - note / task: not linked to any inaccessible opportunity
// Inserts and updates of those related records must point to an opportunity the
// caller can update, reusing Twenty's inherited-parent write check.
//
// Everything is plain SQL on existing tables: no schema change, no cache.
// subject.principalIds is [EVERYONE, workspaceMemberId, ...roleIds], so it is
// matched both against core.role (admin check) and the member columns.
//
// Policies are expression trees ({ kind: 'and' | 'or' | 'roleFilter' | ... })
// that are compiled to SQL for queries and evaluated in memory against record
// snapshots for event gates (realtime, webhooks, database-event triggers). Only
// a 'roleFilter' node carries raw SQL, so the restriction is added as one; its
// recordFilter is what the in-memory evaluation reads instead.
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "buildRowAccessPolicy", {
    enumerable: true,
    get: function() {
        return buildRowAccessPolicy;
    }
});
const _original = require("./build-row-access-policy.util.orig");
const _ismanytooneflatfieldmetadatautil = require("./is-many-to-one-flat-field-metadata.util");
const _computemorphorrelationfieldjoincolumnnameutil = require("../../metadata-modules/field-metadata/utils/compute-morph-or-relation-field-join-column-name.util");
const OPPORTUNITY = 'opportunity';
const WORKSPACE_MEMBER = 'workspaceMember';
const TARGET_OPPORTUNITY_COLUMN = 'targetOpportunityId';
const TARGET_OBJECTS = [
    'noteTarget',
    'taskTarget',
    'attachment',
    'timelineActivity'
];
const ACTIVITY_OBJECTS = {
    note: {
        targetObject: 'noteTarget',
        foreignKey: 'noteId'
    },
    task: {
        targetObject: 'taskTarget',
        foreignKey: 'taskId'
    }
};
const PRINCIPALS_PARAM = 'rlsOpportunityPrincipalIds';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Record filters for the in-memory evaluation: an empty "not" always matches,
// deleted records included, and negating it never does
const MATCH_ALL_FILTER = {
    not: {}
};
const MATCH_NONE_FILTER = {
    not: {
        not: {}
    }
};
const isEnabled = ()=>process.env.RLS_OPPORTUNITY_ENABLED !== 'false';
const memberFieldNames = ()=>(process.env.RLS_OPPORTUNITY_MEMBER_FIELDS || 'owner,editors').split(',').map((name)=>name.trim()).filter(Boolean);
const quote = (identifier)=>`"${String(identifier).replace(/"/g, '""')}"`;
const joinColumnOf = (field)=>(0, _computemorphorrelationfieldjoincolumnnameutil.computeMorphOrRelationFieldJoinColumnName)({
        name: field.name
    });
const isOneToMany = (field)=>field.settings?.relationType === 'ONE_TO_MANY';
// Resolved from the metadata maps, which are rebuilt whenever metadata changes,
// so they are safe cache keys.
const configCache = new WeakMap();
const resolveConfig = (flatObjectMetadataMaps, flatFieldMetadataMaps)=>{
    const cacheKey = memberFieldNames().join(',');
    const cached = configCache.get(flatFieldMetadataMaps)?.get(flatObjectMetadataMaps);
    if (cached?.cacheKey === cacheKey) {
        return cached.config;
    }
    const objectsByName = new Map();
    const objectsById = new Map();
    for (const object of Object.values(flatObjectMetadataMaps.byUniversalIdentifier)){
        if (object) {
            objectsByName.set(object.nameSingular, object);
            objectsById.set(object.id, object);
        }
    }
    const fieldsById = new Map();
    const fieldsByObjectId = new Map();
    for (const field of Object.values(flatFieldMetadataMaps.byUniversalIdentifier)){
        if (!field || field.deletedAt) {
            continue;
        }
        fieldsById.set(field.id, field);
        if (!fieldsByObjectId.has(field.objectMetadataId)) {
            fieldsByObjectId.set(field.objectMetadataId, []);
        }
        fieldsByObjectId.get(field.objectMetadataId).push(field);
    }
    const opportunity = objectsByName.get(OPPORTUNITY);
    const workspaceMember = objectsByName.get(WORKSPACE_MEMBER);
    let config = null;
    if (opportunity && workspaceMember) {
        const opportunityFields = fieldsByObjectId.get(opportunity.id) ?? [];
        const pointsToMember = (field)=>field && (0, _ismanytooneflatfieldmetadatautil.isManyToOneFlatFieldMetadata)(field) && field.relationTargetObjectMetadataId === workspaceMember.id;
        const memberColumns = [];
        const junctions = [];
        for (const name of memberFieldNames()){
            const field = opportunityFields.find((candidate)=>candidate.name === name);
            if (pointsToMember(field)) {
                memberColumns.push(joinColumnOf(field));
            } else if (field && isOneToMany(field)) {
                const junctionObject = objectsById.get(field.relationTargetObjectMetadataId);
                const opportunityField = fieldsById.get(field.relationTargetFieldMetadataId);
                const junctionFields = junctionObject ? fieldsByObjectId.get(junctionObject.id) ?? [] : [];
                const memberField = [
                    fieldsById.get(field.settings?.junctionTargetFieldId),
                    ...junctionFields
                ].find(pointsToMember);
                if (junctionObject && opportunityField && memberField) {
                    junctions.push({
                        object: junctionObject,
                        opportunityField,
                        memberColumn: joinColumnOf(memberField)
                    });
                }
            }
        }
        // Objects whose rows belong to one opportunity, with the relation pointing to it
        const opportunityLinks = new Map();
        for (const name of TARGET_OBJECTS){
            const object = objectsByName.get(name);
            const field = object && (fieldsByObjectId.get(object.id) ?? []).find((candidate)=>(0, _ismanytooneflatfieldmetadatautil.isManyToOneFlatFieldMetadata)(candidate) && joinColumnOf(candidate) === TARGET_OPPORTUNITY_COLUMN);
            if (field) {
                opportunityLinks.set(object.id, {
                    fieldMetadataId: field.id,
                    joinColumnName: TARGET_OPPORTUNITY_COLUMN
                });
            }
        }
        for (const { object, opportunityField } of junctions){
            opportunityLinks.set(object.id, {
                fieldMetadataId: opportunityField.id,
                joinColumnName: joinColumnOf(opportunityField)
            });
        }
        config = {
            opportunity,
            memberColumns,
            junctions,
            opportunityLinks,
            objectsByName
        };
    }
    if (!configCache.has(flatFieldMetadataMaps)) {
        configCache.set(flatFieldMetadataMaps, new WeakMap());
    }
    configCache.get(flatFieldMetadataMaps).set(flatObjectMetadataMaps, {
        cacheKey,
        config
    });
    return config;
};
const roleFilterExpression = ({ tableAlias, flatObjectMetadata, condition, recordFilter })=>({
        kind: 'roleFilter',
        tableAlias,
        flatObjectMetadata,
        recordFilter,
        condition
    });
const buildOpportunityOwnerEditorExpression = ({ subject, environment, tableAlias, flatObjectMetadata })=>{
    if (!isEnabled() || subject.isSystemContext) {
        return undefined;
    }
    const config = resolveConfig(environment.flatObjectMetadataMaps, environment.flatFieldMetadataMaps);
    if (!config) {
        return undefined;
    }
    const { opportunity, memberColumns, junctions, opportunityLinks, objectsByName } = config;
    const name = flatObjectMetadata.nameSingular;
    const activity = ACTIVITY_OBJECTS[name];
    const link = opportunityLinks.get(flatObjectMetadata.id);
    if (name !== OPPORTUNITY && !activity && !link) {
        return undefined;
    }
    // Event gates build the policy without table access and evaluate it on
    // snapshots, where neither the junction nor core.role can be read: only
    // roles with access to all records get the events
    if (typeof environment.resolveTableExpression !== 'function') {
        return subject.canAccessAllRecords ? undefined : roleFilterExpression({
            tableAlias,
            flatObjectMetadata,
            condition: {
                sql: 'FALSE',
                parameters: {}
            },
            recordFilter: MATCH_NONE_FILTER
        });
    }
    const principals = `CAST(:${PRINCIPALS_PARAM} AS uuid[])`;
    const alias = quote(tableAlias);
    const memberMatch = (rowAlias)=>{
        const conditions = [
            ...memberColumns.map((column)=>`${rowAlias}.${quote(column)} = ANY(${principals})`),
            ...junctions.map(({ object, opportunityField, memberColumn }, index)=>`EXISTS (SELECT 1 FROM ${environment.resolveTableExpression(object.id)} "rls_j${index}" WHERE "rls_j${index}".${quote(joinColumnOf(opportunityField))} = ${rowAlias}."id" AND "rls_j${index}".${quote(memberColumn)} = ANY(${principals}) AND "rls_j${index}"."deletedAt" IS NULL)`)
        ];
        return conditions.length === 0 ? 'FALSE' : conditions.join(' OR ');
    };
    const accessibleOpportunityIds = `SELECT "rls_o"."id" FROM ${environment.resolveTableExpression(opportunity.id)} "rls_o" WHERE ${memberMatch('"rls_o"')}`;
    let restriction;
    if (name === OPPORTUNITY) {
        restriction = memberMatch(alias);
    } else if (activity) {
        const target = objectsByName.get(activity.targetObject);
        const targetLink = target && opportunityLinks.get(target.id);
        if (!targetLink) {
            return undefined;
        }
        const column = `"rls_t".${quote(targetLink.joinColumnName)}`;
        restriction = `NOT EXISTS (SELECT 1 FROM ${environment.resolveTableExpression(target.id)} "rls_t" WHERE "rls_t".${quote(activity.foreignKey)} = ${alias}."id" AND "rls_t"."deletedAt" IS NULL AND ${column} IS NOT NULL AND ${column} NOT IN (${accessibleOpportunityIds}))`;
    } else {
        const column = `${alias}.${quote(link.joinColumnName)}`;
        restriction = `${column} IS NULL OR ${column} IN (${accessibleOpportunityIds})`;
    }
    const isAdmin = `EXISTS (SELECT 1 FROM "core"."role" "rls_r" WHERE "rls_r"."id" = ANY(${principals}) AND "rls_r"."canUpdateAllSettings" = true)`;
    // Updates are re-checked in memory with this recordFilter; the SQL check of
    // the update query and the parent write check already cover this restriction
    return roleFilterExpression({
        tableAlias,
        flatObjectMetadata,
        condition: {
            sql: `(${isAdmin} OR ${restriction})`,
            parameters: {
                [PRINCIPALS_PARAM]: (subject.principalIds ?? []).filter((id)=>UUID_REGEX.test(id))
            }
        },
        recordFilter: MATCH_ALL_FILTER
    });
};
const buildRowAccessPolicy = (args)=>{
    const policy = (0, _original.buildRowAccessPolicy)(args);
    if (policy.kind === 'denied') {
        return policy;
    }
    const expression = buildOpportunityOwnerEditorExpression(args);
    if (!expression) {
        return policy;
    }
    return {
        kind: 'gated',
        expression: policy.kind === 'gated' ? {
            kind: 'and',
            operands: [
                policy.expression,
                expression
            ]
        } : expression
    };
};
// Writes: make Twenty's inherited-parent check (insert / update / upsert) also
// treat opportunity-linked objects as children of their opportunity, so a new or
// moved record must point to an opportunity the caller can update. That check
// queries the parent with applyWriteRowLevelPermissions, i.e. the policy above.
// Without it a member could add themselves to any opportunity's editors.
// workspace-repository requires this module, so it is patched once loaded.
const patchWorkspaceRepository = ()=>{
    const { WorkspaceRepository } = require("../repository/workspace-repository");
    const prototype = WorkspaceRepository.prototype;
    if (prototype.rlsOpportunityPatched) {
        return;
    }
    const resolveOwnParentLinks = prototype.resolveOwnParentLinks;
    if (typeof resolveOwnParentLinks !== 'function') {
        throw new Error('WorkspaceRepository.prototype.resolveOwnParentLinks not found');
    }
    prototype.resolveOwnParentLinks = function() {
        const links = resolveOwnParentLinks.call(this);
        if (!isEnabled()) {
            return links;
        }
        const { internalContext, flatObjectMetadata } = this.options;
        const config = resolveConfig(internalContext.flatObjectMetadataMaps, internalContext.flatFieldMetadataMaps);
        const link = config?.opportunityLinks.get(flatObjectMetadata.id);
        if (!link || links.some((existing)=>existing.joinColumnName === link.joinColumnName)) {
            return links;
        }
        return [
            ...links,
            {
                kind: 'column',
                fieldMetadataId: link.fieldMetadataId,
                joinColumnName: link.joinColumnName,
                parentFlatObjectMetadata: config.opportunity
            }
        ];
    };
    prototype.rlsOpportunityPatched = true;
};
setImmediate(()=>{
    try {
        patchWorkspaceRepository();
    } catch (error) {
        console.error('[rls-opportunity] failed to patch WorkspaceRepository write checks', error);
    }
});
