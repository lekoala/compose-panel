# Compose Panel — single-process Bun app + Docker CLI, built from scratch.
# No other panel image is used as a base.
ARG BUN_VERSION=1.4.3
# Pinned engine versions: rebuilding the same commit installs the same tools.
# Refresh deliberately (never silently) and re-verify with the smoke checklist.
ARG DOCKER_CLI_VERSION=5:29.9.0-1~debian.13~trixie
ARG DOCKER_COMPOSE_VERSION=5.6.0-1~debian.13~trixie

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ARG DOCKER_CLI_VERSION
ARG DOCKER_COMPOSE_VERSION
# Docker CLI + Compose plugin from Docker's official apt repository so the
# exact engine the panel shells out to is present and verifiable in the image.
# (Build-time shell only; the panel itself never uses a shell at runtime.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:5081/health/live || exit 1
ENTRYPOINT ["bun", "src/server.ts"]
