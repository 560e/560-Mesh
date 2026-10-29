#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
export DOCKER_CONFIG="$PROJECT_DIR/.docker"
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "Usage: sh scripts/bootstrap.sh https://hs.example.com [tailnet.example.com]" >&2
    exit 2
fi
docker compose version >/dev/null
# The caller must build or import the image first; never silently pull an unrelated image.
IMAGE=$(docker compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["platform"]["image"])')
docker image inspect "$IMAGE" >/dev/null
# The initializer creates only known config/data paths, never overwrites files,
# and assigns newly-created paths to the image UID 65532.
docker run --rm --user 0:0 --network none \
    --mount "type=bind,src=$PROJECT_DIR,dst=/workspace" \
    "$IMAGE" init --root /workspace --url "$1" --base-domain "${2:-}"
sh scripts/validate.sh
