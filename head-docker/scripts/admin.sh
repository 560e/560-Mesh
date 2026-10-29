#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
export DOCKER_CONFIG="$PROJECT_DIR/.docker"
case "${1:-}" in
    create|reset)
        test "$#" = 2 || { echo 'Usage: sh scripts/admin.sh create|reset <username>' >&2; exit 2; }
        test -t 0 || { echo 'Run interactively so the password is not stored in shell history.' >&2; exit 2; }
        trap 'stty echo; unset ADMIN_PASSWORD ADMIN_CONFIRM' EXIT HUP INT TERM
        printf '请输入密码（至少 12 个字符）: ' >&2
        stty -echo
        IFS= read -r ADMIN_PASSWORD
        printf '\n再次输入密码: ' >&2
        IFS= read -r ADMIN_CONFIRM
        stty echo
        printf '\n' >&2
        test "$ADMIN_PASSWORD" = "$ADMIN_CONFIRM" || { echo '两次密码不一致。' >&2; exit 2; }
        printf '%s' "$ADMIN_PASSWORD" | docker compose exec -T platform /nodejs/bin/node /app/build/cli/admin.mjs "$1" "$2"
        unset ADMIN_PASSWORD ADMIN_CONFIRM
        ;;
    list|disable)
        docker compose exec -T platform /nodejs/bin/node /app/build/cli/admin.mjs "$@"
        ;;
    *) echo 'Usage: sh scripts/admin.sh create|reset|disable <username>, or list' >&2; exit 2 ;;
esac
