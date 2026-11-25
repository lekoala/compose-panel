#!/usr/bin/env bash
# End-to-end managed-site deploy (tests/managed-site-e2e-linux.test.ts) on a
# disposable Docker-in-Docker daemon:
#   bun run test:managed-sites-e2e:wsl   # from Windows, through WSL
#   bash scripts/managed-sites-e2e/run.sh   # on a Linux dev machine or VM
#
# It drives the real deploy code against a real Git repository and a real
# Compose project, then kills the deploy process after the gateway stop and
# after the pointer switch. The lab daemon comes from scripts/docker-lab/lib.sh
# and is removed with its storage on exit; nothing on the host daemon is touched.
# Needs Docker with the Compose plugin, rsync, git and Bun in ~/.bun.
set -euo pipefail

SRC="$(pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
NAME="compose-panel-e2e-$$"
PORT="${COMPOSE_PANEL_E2E_PORT:-18432}"

if [ ! -x "$BUN" ]; then
    echo "Bun not found at $BUN. Install it first:" >&2
    echo '  curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.5"' >&2
    exit 1
fi
if ! command -v git >/dev/null 2>&1; then
    echo "git is required to build the two-commit fixture." >&2
    exit 1
fi

source "$HERE/../docker-lab/lib.sh"
LAB_NAME="$NAME"
LAB_IMAGE="${COMPOSE_PANEL_LAB_IMAGE:-docker:29.9.0-dind}"
trap lab_on_exit EXIT
lab_start

# Seed from the outer daemon's cache so a rate-limited registry cannot fail a
# suite that is not about pulling.
lab_seed_from_cache "${COMPOSE_PANEL_LAB_BASE_IMAGE:-alpine:3.20}" "${COMPOSE_PANEL_E2E_WEB_IMAGE:-nginx:alpine}" \
    "nginx:1.27-alpine" "${COMPOSE_PANEL_E2E_RUNTIME_IMAGE:-php:8.3-fpm-alpine}" \
    "${COMPOSE_PANEL_E2E_BUILD_IMAGE:-composer:2.10.3}" "${COMPOSE_PANEL_E2E_DATABASE_IMAGE:-mariadb:11}" \
    "${COMPOSE_PANEL_E2E_BACKUP_IMAGE:-restic/restic:0.18.0}" "${COMPOSE_PANEL_E2E_REST_SERVER_IMAGE:-restic/rest-server:0.15.0}"

# Copy the working tree into the Linux file system (/mnt/* is not one).
mkdir "$LAB_DIR/app"
rsync -a --exclude node_modules --exclude .git --exclude private "$SRC/" "$LAB_DIR/app/"
cd "$LAB_DIR/app"
"$BUN" install --frozen-lockfile >/dev/null

COMPOSE_PANEL_TEST_DOCKER_LAB=1 \
COMPOSE_PANEL_LAB_SHARED="$LAB_SHARED" \
COMPOSE_PANEL_LAB_CONTAINER="$LAB_CONTAINER_ID" \
COMPOSE_PANEL_LAB_OUTER_CONTEXT="${LAB_OUTER_CONTEXT:-}" \
COMPOSE_PANEL_E2E_PORT="$PORT" \
    "$BUN" test tests/managed-site-e2e-linux.test.ts "$@"
