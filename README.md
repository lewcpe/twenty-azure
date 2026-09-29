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
| `opportunity` | the current workspace member is in any of the configured member fields (default `owner`, `editor`) |
| `noteTarget`, `taskTarget`, `attachment`, `timelineActivity` | `targetOpportunityId` is empty or points to an accessible opportunity |
| `note`, `task` | not linked to any inaccessible opportunity |

Setup: in **Settings → Data model → Opportunities**, add a **Relation** field named `editor` → *Workspace Members* (many opportunities to one member). `owner` already exists. If a configured field doesn't exist, it's ignored.

```env
RLS_OPPORTUNITY_ENABLED=true               # set to false to turn it off
RLS_OPPORTUNITY_MEMBER_FIELDS=owner,editor # opportunity relation fields that grant access
```

Notes / known gaps:
- API keys with a non-admin role see no opportunities, because they have no workspace member.
- Role-based event gates (realtime pushes, database-event workflow/logic-function triggers for non-admin roles) are restricted the same way, so they won't fire for opportunities.
- Users can still create a note/task/attachment linked to an opportunity they can't see.

## Building Locally

```bash
# Build v1 image
docker build -t twenty-azure:v1 ./v1

# Build v2 image
docker build -t twenty-azure:v2 ./v2
```