#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
export DOCKER_CONFIG="$PROJECT_DIR/.docker"
docker compose exec -T platform /nodejs/bin/node /opt/560-platform/healthcheck.mjs
curl --fail --silent --show-error http://127.0.0.1:56201/health >/dev/null
curl --fail --silent --show-error http://127.0.0.1:56005/adminis/healthz >/dev/null
STATUS=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://127.0.0.1:56005/admin)
test "$STATUS" = 404
if [ "$#" -gt 0 ]; then
    curl --fail --silent --show-error "$1/health" >/dev/null
    STATUS=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$1/admin")
    test "$STATUS" = 404
    curl --fail --silent --show-error "$1/adminis/login" >/dev/null
fi
echo 'HTTP smoke checks passed; this is not a client, ACL or restore acceptance test.'
