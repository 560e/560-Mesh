#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
export DOCKER_CONFIG="$PROJECT_DIR/.docker"
docker compose exec -T platform /nodejs/bin/node /opt/560-platform/api-key.mjs --rotate
docker compose restart platform
echo '已轮换服务器 API Key 并重启。验证管理操作后，请检查并吊销不再使用的旧 Key。'
