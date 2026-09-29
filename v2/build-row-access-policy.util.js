"use strict";
// Owner/editor row-level security for opportunities (twenty-azure patch).
//
// Wraps Twenty's buildRowAccessPolicy, which WorkspaceRepository calls for the
// main table and every joined table alias of select / update / delete queries.
// The original is kept as ./build-row-access-policy.util.orig.js (renamed in the
// Dockerfile) and still decides first, so role permissions, built-in RLS and
// record sharing keep working; this only narrows the result further.
//
// Unless one of the caller's roles has canUpdateAllSettings (admins):
//   - opportunity: one of RLS_OPPORTUNITY_MEMBER_FIELDS (default "owner,editor")
//     points to the current workspace member
//   - noteTarget / taskTarget / attachment / timelineActivity: targetOpportunityId
//     is null or an accessible opportunity
//   - note / task: not linked to any inaccessible opportunity
//
// Everything is plain SQL on existing tables: no schema change, no cache.
// subject.principalIds is [EVERYONE, workspaceMemberId, ...roleIds], so it is
// matched both against core.role (admin check) and the member columns.
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
const _combinesqlconditionsutil = require("./combine-sql-conditions.util");
const _ismanytooneflatfieldmetadatautil = require("./is-many-to-one-flat-field-metadata.util");
const _computemorphorrelationfieldjoincolumnnameutil = require("../../metadata-modules/field-metadata/utils/compute-morph-or-relation-field-join-column-name.util");
const OPPORTUNITY = 'opportunity';
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
const isEnabled = ()=>process.env.RLS_OPPORTUNITY_ENABLED !== 'false';
const memberFieldNames = ()=>(process.env.RLS_OPPORTUNITY_MEMBER_FIELDS || 'owner,editor').split(',').map((name)=>name.trim()).filter(Boolean);
const quote = (identifier)=>`"${String(identifier).replace(/"/g, '""')}"`;
// Metadata maps are rebuilt whenever metadata changes, so they are safe cache keys.
const objectByNameCache = new WeakMap();
const findObjectByName = (flatObjectMetadataMaps, nameSingular)=>{
    let byName = objectByNameCache.get(flatObjectMetadataMaps);
    if (!byName) {
        byName = new Map(Object.values(flatObjectMetadataMaps.byUniversalIdentifier).filter(Boolean).map((object)=>[
                object.nameSingular,
                object
            ]));
        objectByNameCache.set(flatObjectMetadataMaps, byName);
    }
    return byName.get(nameSingular);
};
const columnsCache = new WeakMap();
// Join column names of the many-to-one relation fields of an object, by field name.
const getJoinColumns = (flatFieldMetadataMaps, objectMetadataId)=>{
    let byObject = columnsCache.get(flatFieldMetadataMaps);
    if (!byObject) {
        byObject = new Map();
        for (const field of Object.values(flatFieldMetadataMaps.byUniversalIdentifier)){
            if (!field || field.deletedAt || !(0, _ismanytooneflatfieldmetadatautil.isManyToOneFlatFieldMetadata)(field)) {
                continue;
            }
            const joinColumnName = (0, _computemorphorrelationfieldjoincolumnnameutil.computeMorphOrRelationFieldJoinColumnName)({
                name: field.name
            });
            if (!byObject.has(field.objectMetadataId)) {
                byObject.set(field.objectMetadataId, new Map());
            }
            byObject.get(field.objectMetadataId).set(field.name, joinColumnName);
        }
        columnsCache.set(flatFieldMetadataMaps, byObject);
    }
    return byObject.get(objectMetadataId) ?? new Map();
};
const buildOpportunityOwnerEditorCondition = ({ subject, environment, tableAlias, flatObjectMetadata })=>{
    if (!isEnabled() || subject.isSystemContext) {
        return undefined;
    }
    const name = flatObjectMetadata.nameSingular;
    const activity = ACTIVITY_OBJECTS[name];
    if (name !== OPPORTUNITY && !TARGET_OBJECTS.includes(name) && !activity) {
        return undefined;
    }
    const opportunity = findObjectByName(environment.flatObjectMetadataMaps, OPPORTUNITY);
    if (!opportunity) {
        return undefined;
    }
    const opportunityColumns = getJoinColumns(environment.flatFieldMetadataMaps, opportunity.id);
    const memberColumns = memberFieldNames().map((field)=>opportunityColumns.get(field)).filter(Boolean);
    const principals = `CAST(:${PRINCIPALS_PARAM} AS uuid[])`;
    const alias = quote(tableAlias);
    const memberMatch = (rowAlias)=>memberColumns.length === 0 ? 'FALSE' : memberColumns.map((column)=>`${rowAlias}.${quote(column)} = ANY(${principals})`).join(' OR ');
    const accessibleOpportunityIds = `SELECT "rls_o"."id" FROM ${environment.resolveTableExpression(opportunity.id)} "rls_o" WHERE ${memberMatch('"rls_o"')}`;
    const hasTargetOpportunityColumn = (objectMetadataId)=>[
            ...getJoinColumns(environment.flatFieldMetadataMaps, objectMetadataId).values()
        ].includes(TARGET_OPPORTUNITY_COLUMN);
    let restriction;
    if (name === OPPORTUNITY) {
        restriction = memberMatch(alias);
    } else if (activity) {
        const target = findObjectByName(environment.flatObjectMetadataMaps, activity.targetObject);
        if (!target || !hasTargetOpportunityColumn(target.id)) {
            return undefined;
        }
        restriction = `NOT EXISTS (SELECT 1 FROM ${environment.resolveTableExpression(target.id)} "rls_t" WHERE "rls_t".${quote(activity.foreignKey)} = ${alias}."id" AND "rls_t"."deletedAt" IS NULL AND "rls_t".${quote(TARGET_OPPORTUNITY_COLUMN)} IS NOT NULL AND "rls_t".${quote(TARGET_OPPORTUNITY_COLUMN)} NOT IN (${accessibleOpportunityIds}))`;
    } else {
        if (!hasTargetOpportunityColumn(flatObjectMetadata.id)) {
            return undefined;
        }
        const column = `${alias}.${quote(TARGET_OPPORTUNITY_COLUMN)}`;
        restriction = `${column} IS NULL OR ${column} IN (${accessibleOpportunityIds})`;
    }
    const isAdmin = `EXISTS (SELECT 1 FROM "core"."role" "rls_r" WHERE "rls_r"."id" = ANY(${principals}) AND "rls_r"."canUpdateAllSettings" = true)`;
    return {
        sql: `(${isAdmin} OR ${restriction})`,
        parameters: {
            [PRINCIPALS_PARAM]: (subject.principalIds ?? []).filter((id)=>UUID_REGEX.test(id))
        }
    };
};
const buildRowAccessPolicy = (args)=>{
    const policy = (0, _original.buildRowAccessPolicy)(args);
    if (policy.kind === 'denied') {
        return policy;
    }
    const condition = buildOpportunityOwnerEditorCondition(args);
    if (!condition) {
        return policy;
    }
    return {
        kind: 'gated',
        condition: policy.kind === 'gated' ? (0, _combinesqlconditionsutil.combineSqlConditions)([
            policy.condition,
            condition
        ]) : condition
    };
};
