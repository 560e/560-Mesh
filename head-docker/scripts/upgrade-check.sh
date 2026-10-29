#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
export DOCKER_CONFIG="$PROJECT_DIR/.docker"
python3 -c 'import json; print(json.dumps(json.load(open("sources.lock.json")), indent=2))'
docker compose images
docker compose ps
echo 'This command is read-only. Review upstream releases, back up and test before changing either component.'
