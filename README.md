# twenty-azure

Custom Docker images for Twenty CRM with support for single-tenant / custom Azure AD (Microsoft OAuth) authentication.

By default, Twenty CRM hardcodes `tenant: 'common'`, which causes Azure AD single-tenant app registrations to fail with `AADSTS50194`. This image patches `microsoft.auth.strategy.js` to support `AUTH_MICROSOFT_TENANT_ID`.

## Image Variants

| Variant | Base Image | Context | Image Tags |
|---|---|---|---|
| **v1** | `twentycrm/twenty:v1` | `./v1` | `ghcr.io/<repo>:v1` |
| **v2** | `twentycrm/twenty:v2` | `./v2` | `ghcr.io/<repo>:v2`, `ghcr.io/<repo>:latest` |

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
4. Optional: enable the **Junction Relations** feature in *Settings → Releases / Lab*, then configure `editors` on Opportunities to show members through the junction (target field `workspaceMember`).

The patch finds the member relation from the junction settings, or else from the first relation on the junction object that points to *Workspace Members*. So step 4 only changes how editors appear in the UI.

```env
RLS_OPPORTUNITY_ENABLED=true                # set to false to turn it off
RLS_OPPORTUNITY_MEMBER_FIELDS=owner,editors # opportunity fields that grant access: relations to
                                            # Workspace Members, or one-to-many to a junction object
```

Notes / known gaps:
- API keys with a non-admin role see no opportunities, because they have no workspace member.
- Role-based event gates (realtime pushes, database-event workflow/logic-function triggers for non-admin roles) are restricted the same way, so they won't fire for opportunities.
- The write check is installed by wrapping `WorkspaceRepository.prototype.resolveOwnParentLinks`. If a future `v2` build renames that method, reads are still filtered, but the write check logs `[rls-opportunity] failed to patch` at startup.

## Building Locally

```bash
# Build v1 image
docker build -t twenty-azure:v1 ./v1

# Build v2 image
docker build -t twenty-azure:v2 ./v2
```