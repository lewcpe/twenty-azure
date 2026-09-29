FROM twentycrm/twenty:v2
COPY microsoft.auth.strategy.js /app/packages/twenty-server/dist/engine/core-modules/auth/strategies/microsoft.auth.strategy.js

# Opportunity owner/editor row-level security: keep the original util as .orig.js and wrap it
ARG RLS_UTIL=/app/packages/twenty-server/dist/engine/twenty-orm/utils/build-row-access-policy.util.js
RUN test -f "$RLS_UTIL" && mv "$RLS_UTIL" "${RLS_UTIL%.js}.orig.js"
COPY --chown=1000 build-row-access-policy.util.js /app/packages/twenty-server/dist/engine/twenty-orm/utils/build-row-access-policy.util.js
