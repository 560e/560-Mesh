#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"
export DOCKER_CONFIG="$PROJECT_DIR/.docker"
exec docker compose "$@"
