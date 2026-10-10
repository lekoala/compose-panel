# Compose Panel — single-process Bun app + Docker CLI, built from scratch.
# No other panel image is used as a base.
ARG BUN_VERSION=1.4.3
# Base image pinned by version AND multi-arch index digest so a rebuild cannot
# silently pick up a different tag. Bump both together, deliberately, and
# re-verify with the smoke checklist. Resolve a new digest with
# `docker buildx imagetools inspect oven/bun:${BUN_VERSION}-slim`.
ARG BUN_DIGEST=sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
# Pinned engine versions: rebuilding the same commit installs the same tools.
# Refresh deliberately (never silently) and re-verify with the smoke checklist.
ARG DOCKER_CLI_VERSION=5:29.9.0-1~debian.13~trixie
# Keep COMPOSE_VERSION in .github/workflows/ci.yml on the same release, and
# drop the matching .trivyignore.yaml entries once a fixed release is pinned.
ARG DOCKER_COMPOSE_VERSION=5.6.0-1~debian.13~trixie

FROM oven/bun:${BUN_VERSION}-slim@${BUN_DIGEST} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:${BUN_VERSION}-slim@${BUN_DIGEST} AS runtime
ARG DOCKER_CLI_VERSION
ARG DOCKER_COMPOSE_VERSION
# OCI image metadata. Version and revision are deterministic build inputs (no
# timestamp), so the same commit still builds a byte-identical image. There is
# no OCI "icon" field: a registry logo is configured on the registry side.
ARG BUN_VERSION
ARG VERSION=dev
ARG REVISION=unknown
# Docker CLI + Compose plugin from Docker's official apt repository so the
# exact engine the panel shells out to is present and verifiable in the image.
# (Build-time shell only; the panel itself never uses a shell at runtime.)
# No gnupg: apt reads the ASCII-armored key named by signed-by directly, and
# gnupg would only add unused packages (and their CVEs) to the image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli=${DOCKER_CLI_VERSION} docker-compose-plugin=${DOCKER_COMPOSE_VERSION} curl \
    && rm -rf /var/lib/apt/lists/* \
    && docker --version \
    && docker compose version
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY public ./public
# The panel always binds 127.0.0.1 (see src/server.ts); reach it via the host
# loopback (host networking) or an SSH tunnel, never a public port.
ENV PORT=5081 \
    STACKS_DIR=/stacks
LABEL org.opencontainers.image.title="Compose Panel" \
    org.opencontainers.image.description="Single-server panel to administer Docker Compose stacks (loopback-only, one trusted administrator)." \
    org.opencontainers.image.url="https://github.com/lekoala/compose-panel" \
    org.opencontainers.image.source="https://github.com/lekoala/compose-panel" \
    org.opencontainers.image.licenses="EUPL-1.2" \
    org.opencontainers.image.vendor="LeKoala" \
    org.opencontainers.image.version="${VERSION}" \
    org.opencontainers.image.revision="${REVISION}" \
    org.opencontainers.image.base.name="docker.io/oven/bun:${BUN_VERSION}-slim"
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:5081/health/live || exit 1
ENTRYPOINT ["bun", "src/server.ts"]
