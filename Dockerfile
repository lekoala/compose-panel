# Compose Panel — single-process Bun app + Docker CLI, built from scratch.
# No other panel image is used as a base.
# Pinned engine versions. Refresh deliberately (never silently) and re-verify
# with the smoke checklist.
ARG DOCKER_CLI_VERSION=5:29.9.2-1~debian.13~trixie
# Keep COMPOSE_VERSION in .github/workflows/ci.yml on the same release, and
# drop the matching .trivyignore.yaml entries once a fixed release is pinned.
ARG DOCKER_COMPOSE_VERSION=5.8.0-1~debian.13~trixie
# `docker buildx imagetools inspect` reads a registry without a builder; it is
# the remote image check's only tool (ADR 0041). 0.39.1 is the newest package
# on 2026-11-25 and still declares github.com/moby/go-archive v0.2.0, so the
# module-level CVE-2026-17106 exception in .trivyignore.yaml applies; the
# vulnerable extraction package is not linked (ADR 0046). Bump this pin and
# drop that entry as soon as a release embeds go-archive v0.3.0+ or stops
# declaring it.
ARG DOCKER_BUILDX_VERSION=0.39.1-1~debian.13~trixie

# Base image pinned by version AND multi-arch index digest so a rebuild cannot
# silently pick up a different image. The reference is written literally (no
# ARG) so Dependabot can propose digest refreshes (.github/dependabot.yml).
# A Bun version bump is manual: change it here, in the base.name label below
# and in the workflows' `bun-version`, together. Resolve a digest with
# `docker buildx imagetools inspect oven/bun:<version>-slim`.
FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643 AS base

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Runtime dependencies only: devDependencies (type definitions) never ship.
# node_modules may be empty while there are no runtime dependencies.
RUN bun install --production --frozen-lockfile && mkdir -p node_modules

FROM base AS runtime
ARG DOCKER_CLI_VERSION
ARG DOCKER_COMPOSE_VERSION
ARG DOCKER_BUILDX_VERSION
# OCI image metadata. Version and revision come from build args (no timestamp).
# Builds are not byte-for-byte reproducible: apt resolves unpinned packages
# (ca-certificates, curl) at build time. There is no OCI "icon" field: a
# registry logo is configured on the registry side.
ARG VERSION=dev
ARG REVISION=unknown
# Docker CLI + Compose plugin from Docker's official apt repository so the
# exact engine the panel shells out to is present and verifiable in the image.
# Managed-site deploy needs Git (ADR 0043) and OpenSSH client for the private
# transport (ADR 0047). Like ca-certificates and curl, these are unpinned; the Docker
# packages stay pinned because the panel's argv depends on their exact version.
# (Build-time shell only; the panel itself never uses a shell at runtime.)
# No gnupg: apt reads the ASCII-armored key named by signed-by directly, and
# gnupg would only add unused packages (and their CVEs) to the image.
# Targeted base-package security fixes (ADR 0038), not a blanket upgrade.
# Install before curl or Docker repository access so downloads use fixed apt.
RUN apt-get update \
    && apt-get install -y --no-install-recommends apt=3.0.4 libapt-pkg7.0=3.0.4 zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli=${DOCKER_CLI_VERSION} docker-compose-plugin=${DOCKER_COMPOSE_VERSION} docker-buildx-plugin=${DOCKER_BUILDX_VERSION} curl \
    && rm -rf /var/lib/apt/lists/* \
    && docker --version \
    && docker compose version \
    && docker buildx version \
    && git --version \
    && /usr/bin/ssh -V
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY --chmod=0755 src/scripts/git-ssh.sh ./src/scripts/git-ssh.sh
RUN bun -e 'await Bun.write("src/build-info.json", JSON.stringify({ version: process.env.VERSION ?? "dev", revision: process.env.REVISION ?? "unknown" }))'
COPY public ./public
# The panel always binds 127.0.0.1 (see src/server.ts); reach it via the host
# loopback (host networking) or an SSH tunnel, never a public port.
ENV PORT=5081 \
    STACKS_DIR=/stacks \
    NODE_ENV=production
LABEL org.opencontainers.image.title="Compose Panel" \
    org.opencontainers.image.description="Single-server panel to administer Docker Compose stacks (loopback-only, one trusted administrator)." \
    org.opencontainers.image.url="https://github.com/lekoala/compose-panel" \
    org.opencontainers.image.source="https://github.com/lekoala/compose-panel" \
    org.opencontainers.image.licenses="EUPL-1.2" \
    org.opencontainers.image.vendor="LeKoala" \
    org.opencontainers.image.version="${VERSION}" \
    org.opencontainers.image.revision="${REVISION}" \
    org.opencontainers.image.base.name="docker.io/oven/bun:1.4.5-slim"
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-5081}/health/live" || exit 1
ENTRYPOINT ["bun", "src/server.ts"]
