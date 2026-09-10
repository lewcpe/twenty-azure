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

## Building Locally

```bash
# Build v1 image
docker build -t twenty-azure:v1 ./v1

# Build v2 image
docker build -t twenty-azure:v2 ./v2
```