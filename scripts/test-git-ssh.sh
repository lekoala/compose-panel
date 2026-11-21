#!/usr/bin/env bash
# Real Git/OpenSSH test in a disposable container with only loopback.
set -euo pipefail

cd "$(dirname "$0")/.."
base_image="$(awk '/^FROM oven\/bun:/ {print $2; exit}' Dockerfile)"
image="$(docker build --quiet --build-arg "BUN_IMAGE=$base_image" - <<'DOCKERFILE'
ARG BUN_IMAGE
FROM ${BUN_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd
DOCKERFILE
)"

docker run --rm --network none \
    --mount "type=bind,src=$PWD/src,dst=/app/src,readonly" \
    --mount "type=bind,src=$PWD/tests/git-release-ssh-linux.test.ts,dst=/app/tests/git-release-ssh-linux.test.ts,readonly" \
    --workdir /app --env COMPOSE_PANEL_TEST_SSH_FIXTURE=1 --entrypoint bun "$image" \
    test tests/git-release-ssh-linux.test.ts
