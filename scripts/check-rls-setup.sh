#!/usr/bin/env bash
# Checks that the opportunity owner/editor RLS patch is installed and that the
# metadata it relies on is in place. Run it from the directory that holds the
# deployment's compose file:
#
#   scripts/check-rls-setup.sh
#
# Settings, all optional:
#   COMPOSE          compose command (default: docker compose)
#   SERVER_SERVICES  services running the Twenty image (default: server worker)
#   DB_SERVICE       postgres service (default: db)
#   DB_USER, DB_NAME postgres user / database (default: POSTGRES_USER / POSTGRES_DB of the db container)
#
# Exits 1 if anything would stop RLS from working, 0 otherwise (warnings included).
set -uo pipefail

COMPOSE=${COMPOSE:-docker compose}
SERVER_SERVICES=${SERVER_SERVICES:-server worker}
DB_SERVICE=${DB_SERVICE:-db}
UTIL=/app/packages/twenty-server/dist/engine/twenty-orm/utils/build-row-access-policy.util.js

failures=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; failures=$((failures + 1)); }
info() { printf '       %s\n' "$*"; }
section() { printf '\n%s\n' "$*"; }

compose() { $COMPOSE "$@"; }
psql_db() {
  # \037 separates fields: unlike tab, `read` keeps empty fields between two of them
  compose exec -T -e SEP=$'\037' -e DB_USER="${DB_USER:-}" -e DB_NAME="${DB_NAME:-}" "$DB_SERVICE" sh -c \
    'exec psql -X -q -A -t -F "$SEP" -v ON_ERROR_STOP=1 -U "${DB_USER:-$POSTGRES_USER}" -d "${DB_NAME:-$POSTGRES_DB}" "$@"' psql "$@"
}

defined=$(compose config --services 2>/dev/null) &&
running=$(compose ps --services --status running 2>/dev/null) || {
  echo "Cannot list compose services. Run this from the deployment directory or set COMPOSE." >&2
  exit 2
}
is_running() { grep -qx "$1" <<< "$running"; }
is_defined() { grep -qx "$1" <<< "$defined"; }

# --- 1. Image -----------------------------------------------------------------
# Builds the policy for a non-admin on a minimal opportunity/owner model and
# compiles it with the image's own code. Catches a patch built for another
# release's policy format, which only fails at query time otherwise.
POLICY_PROBE=$(cat <<'JS'
const { MetadataReadability: R, MetadataWritability: W } = require('twenty-shared/types');
const utils = '/app/packages/twenty-server/dist/engine/twenty-orm/utils/';
const { buildRowAccessPolicy } = require(utils + 'build-row-access-policy.util');
const { compileRowAccessPolicy } = require(utils + 'compile-row-access-policy.util');
const maps = (items) => ({ byUniversalIdentifier: Object.fromEntries(items.map((i) => [i.id, i])), universalIdentifierById: Object.fromEntries(items.map((i) => [i.id, i.id])) });
const object = (id, nameSingular) => ({ id, nameSingular, readability: R.OPEN, writability: W?.OPEN ?? 'OPEN' });
const opportunity = object('opp', 'opportunity');
const environment = {
  flatObjectMetadataMaps: maps([opportunity, object('wm', 'workspaceMember')]),
  flatFieldMetadataMaps: maps([{ id: 'owner', name: 'owner', objectMetadataId: 'opp', type: 'RELATION', settings: { relationType: 'MANY_TO_ONE' }, relationTargetObjectMetadataId: 'wm' }]),
  isRecordSharingEnabled: false, recordShareTableExpression: '"ws"."recordShare"', resolveTableExpression: (id) => `"ws"."${id}"`,
};
const subject = { isSystemContext: false, principalIds: ['00000000-0000-0000-0000-000000000001'], canAccessAllRecords: false, objectsPermissions: undefined, isOwningApplication: () => false, resolveRowLevelPermissionRecordFilter: () => undefined };
try {
  const policy = buildRowAccessPolicy({ subject, environment, tableAlias: 'opportunity', flatObjectMetadata: opportunity, operationType: 'select', depth: 0 });
  const sql = compileRowAccessPolicy({ policy, environment }).condition?.sql ?? '';
  console.log(sql.includes('"ownerId"') ? 'ok' : `no owner restriction in: ${policy.kind} ${sql}`);
} catch (error) {
  console.log(`error: ${error.message}`);
}
process.exit(0);
JS
)
section "Patched image"
services=()
for service in $SERVER_SERVICES; do
  is_defined "$service" || continue
  if ! is_running "$service"; then
    warn "$service: not running, skipped"
    continue
  fi
  services+=("$service")
  version=$(compose exec -T "$service" printenv APP_VERSION 2>/dev/null | tr -d '\r')
  if ! compose exec -T "$service" sh -c "test -f '${UTIL%.js}.orig.js' && grep -q rls-opportunity '$UTIL'" 2>/dev/null; then
    fail "$service: RLS patch missing. Use the ghcr.io/<repo>:v2 image, not twentycrm/twenty (Twenty ${version:-unknown version})"
    continue
  fi
  result=$(compose exec -T -w /app/packages/twenty-server "$service" node - <<< "$POLICY_PROBE" 2>&1 | tail -1 | tr -d '\r')
  if [ "$result" = ok ]; then
    pass "$service: RLS patch installed and works with Twenty ${version:-unknown version}"
  else
    fail "$service: RLS patch doesn't work with Twenty ${version:-unknown version}: $result"
    info "Rebuild the image from this repo's current v2/ for that release"
  fi
done
[ ${#services[@]} -gt 0 ] || fail "none of [$SERVER_SERVICES] is running; set SERVER_SERVICES"

# --- 2. Environment -----------------------------------------------------------
section "Environment"
member_fields=""
for service in "${services[@]}"; do
  enabled=$(compose exec -T "$service" printenv RLS_OPPORTUNITY_ENABLED 2>/dev/null | tr -d '\r')
  fields=$(compose exec -T "$service" printenv RLS_OPPORTUNITY_MEMBER_FIELDS 2>/dev/null | tr -d '\r')
  fields=${fields:-owner,editors}
  if [ "$enabled" = "false" ]; then
    fail "$service: RLS_OPPORTUNITY_ENABLED=false, so the patch is switched off"
  else
    pass "$service: enabled, member fields: $fields"
  fi
  if [ -n "$member_fields" ] && [ "$fields" != "$member_fields" ]; then
    warn "$service: RLS_OPPORTUNITY_MEMBER_FIELDS differs from ${services[0]} ($member_fields)"
  fi
  member_fields=${member_fields:-$fields}
done
member_fields=$(tr -d ' ' <<< "${member_fields:-owner,editors}")

# --- 3. Logs ------------------------------------------------------------------
section "Server logs"
for service in "${services[@]}"; do
  logs=$(compose logs --no-color "$service" 2>&1)
  if grep -q '\[rls-opportunity\] failed' <<< "$logs"; then
    fail "$service: patch reported an error:"
    grep -m1 -A3 '\[rls-opportunity\] failed' <<< "$logs" | sed 's/^/         /'
  else
    pass "$service: no RLS errors"
  fi
done

# --- 4. Metadata, per workspace -------------------------------------------------
# Mirrors resolveConfig() in v2/build-row-access-policy.util.js: each member field
# is either many-to-one to workspaceMember, or one-to-many to a junction object
# with a many-to-one to workspaceMember (the junction target field, else the first one).
section "Data model"
metadata=$(psql_db -v fields="$member_fields" <<'SQL'
with
  workspaces as (
    select id, "displayName" as name, "databaseSchema" as schema
    from core.workspace
    where "deletedAt" is null and "activationStatus" = 'ACTIVE'
  ),
  m2o as (
    select f.* from core."fieldMetadata" f
    where f.type in ('RELATION', 'MORPH_RELATION') and f.settings->>'relationType' = 'MANY_TO_ONE'
  ),
  checked as (
    select w.id as workspace_id, w.name as workspace, w.schema, n.name as field_name, n.position,
           opp.id as opp_id, wm.id as wm_id, f.id as field_id, f."isActive" as field_active,
           f.settings->>'relationType' as relation_type, f."relationTargetObjectMetadataId" as target_id,
           j."nameSingular" as junction, (select t.table_name from information_schema.tables t
            where t.table_schema = w.schema and t.table_name in ('_' || j."nameSingular", j."nameSingular")
            order by length(t.table_name) desc limit 1) as junction_table, j."isActive" as junction_active,
           back.name as back_name, back."isActive" as back_active,
           (back.id in (select id from m2o)) as back_is_m2o,
           member.name as member_name, member."isActive" as member_active
    from workspaces w
    cross join lateral unnest(string_to_array(:'fields', ',')) with ordinality as n(name, position)
    left join core."objectMetadata" opp on opp."workspaceId" = w.id and opp."nameSingular" = 'opportunity'
    left join core."objectMetadata" wm on wm."workspaceId" = w.id and wm."nameSingular" = 'workspaceMember'
    left join core."fieldMetadata" f on f."objectMetadataId" = opp.id and f.name = n.name
    left join core."objectMetadata" j
      on f.settings->>'relationType' = 'ONE_TO_MANY' and j.id = f."relationTargetObjectMetadataId"
    left join core."fieldMetadata" back on j.id is not null and back.id = f."relationTargetFieldMetadataId"
    left join lateral (
      select m.name, m."isActive" from m2o m
      where m."objectMetadataId" = j.id and m."relationTargetObjectMetadataId" = wm.id
      order by (m.id::text = f.settings->>'junctionTargetFieldId') desc, m."createdAt"
      limit 1
    ) member on true
  )
select c.workspace, coalesce(c.schema, ''), c.field_name,
  case
    when c.opp_id is null or c.wm_id is null then 'NO_OBJECTS'
    when c.field_id is null then 'MISSING'
    when c.field_id in (select id from m2o) and c.target_id = c.wm_id then 'DIRECT'
    when c.junction is null then 'WRONG_TYPE'
    when c.back_name is null or not c.back_is_m2o then 'NO_BACK_RELATION'
    when c.member_name is null then 'NO_MEMBER_RELATION'
    else 'JUNCTION'
  end,
  coalesce(c.relation_type, ''), coalesce(c.junction, ''), coalesce(c.junction_table, ''),
  coalesce(c.back_name, ''), coalesce(c.member_name, ''),
  concat_ws(',',
    case when c.field_active = false then 'field' end,
    case when c.junction_active = false then 'junction object' end,
    case when c.back_active = false then c.back_name end,
    case when c.member_active = false then c.member_name end),
  -- the columns the generated SQL reads must exist in the workspace schema
  concat_ws(',',
    case when c.junction is not null and c.member_name is not null and not exists (
      select 1 from information_schema.columns ic
      where ic.table_schema = c.schema and ic.table_name = c.junction_table
        and ic.column_name in (c.back_name || 'Id', c.member_name || 'Id', 'deletedAt')
      having count(*) = 3) then coalesce(c.junction_table, '_' || c.junction) end)
from checked c
order by c.workspace, c.position;
SQL
) || { fail "could not query the database (set DB_SERVICE / DB_USER / DB_NAME)"; metadata=""; }

declare -A schemas=()
declare -A owner_field=()
declare -A junction_tables=()
current=""
while IFS=$'\037' read -r workspace schema field status relation junction table back member inactive missing_columns; do
  [ -n "$workspace" ] || continue
  if [ "$workspace" != "$current" ]; then
    printf '  Workspace "%s"\n' "$workspace"
    current=$workspace
    schemas[$workspace]=$schema
  fi
  case $status in
    NO_OBJECTS) fail "opportunity or workspaceMember object not found" ;;
    MISSING) fail "opportunity.$field doesn't exist. Create it or remove it from RLS_OPPORTUNITY_MEMBER_FIELDS" ;;
    WRONG_TYPE) fail "opportunity.$field is not a relation to Workspace Members or a junction object (${relation:-not a relation})" ;;
    NO_BACK_RELATION) fail "opportunity.$field → $junction: the reverse field on $junction is missing or not many-to-one" ;;
    NO_MEMBER_RELATION)
      fail "opportunity.$field → $junction: $junction has no many-to-one relation to Workspace Members"
      info "Add one on $junction with many $junction rows → one Workspace Member (README setup step 3)" ;;
    DIRECT)
      pass "opportunity.$field → Workspace Member"
      [ "$field" = owner ] && owner_field[$workspace]=1 ;;
    JUNCTION)
      pass "opportunity.$field → $junction.$back, member: $junction.$member"
      junction_tables[$workspace]+="$table:$back:$member " ;;
  esac
  [ -z "$inactive" ] || warn "opportunity.$field: inactive ($inactive). It still grants access but is hidden in the UI"
  [ -z "$missing_columns" ] || fail "table $schema.$missing_columns is missing or lacks the relation columns; the workspace schema is out of sync"
done <<< "$metadata"
[ -n "$current" ] || [ -z "$metadata" ] || fail "no active workspace found"

# --- 5. Who bypasses it, and what members will see --------------------------------
section "Access summary"
admins=$(psql_db <<'SQL'
select w."displayName", r.label, string_agg(distinct u.email, ', ')
from core.role r
join core.workspace w on w.id = r."workspaceId" and w."deletedAt" is null and w."activationStatus" = 'ACTIVE'
left join core."roleTarget" t on t."roleId" = r.id and t."userWorkspaceId" is not null
left join core."userWorkspace" uw on uw.id = t."userWorkspaceId" and uw."deletedAt" is null
left join core."user" u on u.id = uw."userId" and u."deletedAt" is null
where r."canUpdateAllSettings"
group by 1, 2 order by 1, 2;
SQL
) || admins=""
while IFS=$'\037' read -r workspace role emails; do
  [ -n "$workspace" ] || continue
  info "\"$workspace\": role \"$role\" sees every opportunity: ${emails:-no users}"
done <<< "$admins"

for workspace in "${!schemas[@]}"; do
  schema=${schemas[$workspace]}
  [ -n "$schema" ] || continue
  counts="count(*)"
  [ -n "${owner_field[$workspace]:-}" ] && counts+=", count(*) filter (where \"ownerId\" is null)"
  read -r total ownerless < <(psql_db -F ' ' -c "select $counts from \"$schema\".opportunity where \"deletedAt\" is null" 2>/dev/null)
  [ -n "${total:-}" ] || continue
  summary="$total opportunities"
  for entry in ${junction_tables[$workspace]:-}; do
    IFS=: read -r table back member <<< "$entry"
    rows=$(psql_db -c "select count(*) from \"$schema\".\"$table\" where \"deletedAt\" is null and \"${back}Id\" is not null and \"${member}Id\" is not null" 2>/dev/null)
    summary+=", $rows editor links in $table"
  done
  info "\"$workspace\": $summary"
  if [ -n "${ownerless:-}" ] && [ "$ownerless" -gt 0 ]; then
    warn "\"$workspace\": $ownerless opportunities have no owner; only admins and editors can see them"
  fi
done

echo
if [ "$failures" -gt 0 ]; then
  printf '\033[31m%d problem(s) found.\033[0m\n' "$failures"
  exit 1
fi
printf '\033[32mRLS setup is complete.\033[0m\n'
