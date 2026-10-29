# syntax=docker/dockerfile:1.7
FROM ghcr.io/juanfont/headscale:0.29.6@sha256:cabe84f0699913dbca9320f0883dca7565dd08df3c5be29edfabbebeff763966 AS headscale-official
FROM ghcr.io/tale/headplane:0.8.2@sha256:b053a0a6699d0a67be3f0d9bae8e7dbe35ed67ae8448412adcbad7ea49866faa AS headplane-official

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS web-build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates patch \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.4.0 --activate
ADD --checksum=sha256:b34e4e595cd1aa1bc94a70d791bd2afd91e9c0e1b19347776a8960a76ef9c83f \
    https://codeload.github.com/tale/headplane/tar.gz/05e3ee33f6d3b347013654c69186791347be8bd9 /tmp/headplane.tar.gz
WORKDIR /build
RUN tar -xzf /tmp/headplane.tar.gz --strip-components=1 && rm /tmp/headplane.tar.gz
COPY headscale/patches/headplane-560.patch /tmp/headplane-560.patch
COPY headscale/sources.lock.json /tmp/sources.lock.json
RUN node -e "const fs=require('node:fs'),c=require('node:crypto');if(c.createHash('sha256').update(fs.readFileSync('/tmp/headplane-560.patch')).digest('hex')!==JSON.parse(fs.readFileSync('/tmp/sources.lock.json')).headplane.patchSha256)process.exit(1)" \
    && patch --batch --fuzz=0 -p1 < /tmp/headplane-560.patch
# Reuse the upstream WASM; Agent/Web SSH stay disabled in the deployment config.
COPY --from=headplane-official /app/build/client/hp_ssh.wasm /build/public/hp_ssh.wasm
COPY --from=headplane-official /app/build/client/wasm_exec.js /build/public/wasm_exec.js
RUN pnpm install --frozen-lockfile
ENV HEADPLANE_VERSION=0.8.2-560.6
RUN pnpm run test:unit && pnpm run typecheck && pnpm run build && pnpm run build:admin && pnpm run build:runtime

# Keep the upstream security-patched runtime, replacing only the web build.
FROM headplane-official AS runtime
USER 0:0
RUN ["/nodejs/bin/node", "-e", "require('node:fs').rmSync('/app/build',{recursive:true,force:true})"]
COPY --from=web-build /build/build /app/build
COPY --from=web-build /build/drizzle /app/drizzle
COPY --from=headscale-official /ko-app/headscale /usr/local/bin/headscale
COPY head-docker/platform/ /opt/560-platform/
COPY headscale/public/client-home/ /opt/560-platform/public-home/
COPY head-docker/config/ /opt/config/
COPY headscale/LICENSES/ /opt/licenses/
COPY headscale/LICENSE /opt/licenses/560-Mesh-MIT.txt
COPY headscale/sources.lock.json /opt/560-platform/sources.lock.json
ENV HEADPLANE_CONFIG_PATH=/etc/headplane/config.yaml
ENV HEADSCALE_CONFIG=/var/lib/headscale/runtime/headscale.yaml
ENV PLATFORM_CONTROL_GATEWAY=1
ENV PLATFORM_BASE_HEADSCALE_CONFIG=/etc/headscale/config.yaml
ENV PLATFORM_NETWORK_SETTINGS_DIR=/var/lib/headplane/network-settings
WORKDIR /app
USER 65532:65532
EXPOSE 3000 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=6s --start-period=90s --retries=3 \
    CMD ["/nodejs/bin/node", "/opt/560-platform/healthcheck.mjs"]
ENTRYPOINT ["/nodejs/bin/node", "/opt/560-platform/supervisor.mjs"]
CMD []
