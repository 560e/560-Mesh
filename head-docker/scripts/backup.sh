#!/bin/sh
set -eu
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
export DOCKER_CONFIG="$PROJECT_ROOT/.docker"
exec python3 "$PROJECT_ROOT/../headscale/tools/operations.py" --root "$PROJECT_ROOT" backup "$@"
