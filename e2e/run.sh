#!/usr/bin/env bash
# Runs the opportunity RLS e2e test against a throwaway Twenty stack.
#   e2e/run.sh [image]   image defaults to a fresh build of ./v2
set -euo pipefail
cd "$(dirname "$0")"

export E2E_PORT="${E2E_PORT:-3300}"
export TWENTY_IMAGE="${1:-twenty-azure:v2-e2e}"
if [ $# -eq 0 ]; then
  docker build -t "$TWENTY_IMAGE" ../v2
fi

compose() { docker compose -f compose.yml "$@"; }
cleanup() {
  compose logs server > server.log 2>&1 || true
  compose down -v --remove-orphans > /dev/null 2>&1 || true
}
trap cleanup EXIT

compose up -d --wait
compose exec -T server yarn command:prod workspace:seed:dev --light > seed.log 2>&1 \
  || { tail -50 seed.log; exit 1; }

if compose logs server | grep -q '\[rls-opportunity\] failed'; then
  compose logs server | grep -A5 '\[rls-opportunity\] failed'
  exit 1
fi

E2E_BASE_URL="http://localhost:$E2E_PORT" node --test --test-reporter=spec rls.test.mjs
