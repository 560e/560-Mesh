# 560-Mesh contributor instructions

- Read README.md and docs/DEVELOPMENT.md. The repository contains headscale and head-docker siblings.
- Preserve official Headscale and upstream license notices; maintain Headplane changes as the locked complete patch.
- Never commit live config/data, credentials, databases, private logs, backups, or internal server inventories.
- Nginx/reverse proxies, DNS, FRP, firewalls and unrelated services are managed by the operator; do not modify/reload them.
- Do not automatically build/publish images or deployment packages. Perform them only after the human explicitly asks.
- Source compilation, unit/type checks and isolated disposable demos are allowed. Do not use production data for screenshots.
