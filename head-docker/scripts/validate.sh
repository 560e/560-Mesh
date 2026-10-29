#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
export DOCKER_CONFIG="$PROJECT_DIR/.docker"
docker compose version >/dev/null
docker compose config --quiet
test -f config/headscale/config.yaml
test -f config/headplane/config.yaml
if command -v ss >/dev/null 2>&1; then
    echo 'Current listeners (read-only; existing services are never stopped):'
    ss -lntp '( sport = :56005 or sport = :56201 )'
fi
docker compose run --rm --no-deps platform headscale configtest
echo 'Configtest passed. Port availability, HTTPS and actual clients require separate verification.'
