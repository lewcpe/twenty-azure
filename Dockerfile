FROM twentycrm/twenty:latest
COPY microsoft.auth.strategy.js /app/packages/twenty-server/dist/src/engine/core-modules/auth/strategies/microsoft.auth.strategy.js
