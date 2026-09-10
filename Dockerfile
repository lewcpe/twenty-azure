FROM twentycrm/twenty:v1
COPY microsoft.auth.strategy.js /app/packages/twenty-server/dist/src/engine/core-modules/auth/strategies/microsoft.auth.strategy.js
