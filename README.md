# twenty-azure

Build docker image to allow custom tenant in azure ad. sync form twentycrm/twenty:latest

change packages/twenty-server/src/engine/core-modules/auth/strategies/microsoft.auth.strategy.ts

tenant: 'common'

to make it configurable as 

tenant: twentyConfigService.get('AUTH_MICROSOFT_TENANT_ID')