#!/usr/bin/env bash
# Opt-in lifecycle test (tests/docker-lifecycle-linux.test.ts) on a disposable
# Docker-in-Docker daemon:
#   bun run test:docker-lab:wsl        # from Windows, through WSL
#   bash scripts/docker-lab/run.sh     # on a Linux dev machine or disposable VM
#
# Starts a PRIVILEGED docker:dind container on the current daemon. That gives
# the lab its own Docker resources, not the isolation of a VM: run it only on a
# development machine or a throwaway VM, never on a server running real stacks.
# The lab daemon listens on a Unix socket in a private directory (no TCP port),
# carries the engine label compose-panel-lab=1 checked by the test, and is
# removed with its storage on exit. Existing containers are never touched.
# Needs Docker with the Compose plugin, rsync, and Bun in ~/.bun.
set -euo pipefail

SRC="$(pwd)"
BUN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
IMAGE="${COMPOSE_PANEL_LAB_IMAGE:-docker:29.9.0-dind}"
NAME="compose-panel-lab-$$"

if [ ! -x "$BUN" ]; then
    echo "Bun not found at $BUN. Install it first:" >&2
    echo '  curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"' >&2
    exit 1
fi

# The outer daemon only hosts the lab container; nothing else is sent to it.
unset DOCKER_HOST COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROFILES
LAB="$(mktemp -d /tmp/compose-panel-lab.XXXXXX)"
# Shared at the same path on both sides, like the real deployment (host path ==
# container path), so the self-update test can bind-mount a deployment folder
# into containers of the lab daemon. Not under /tmp: the dind entrypoint mounts
# a tmpfs over /tmp, which would hide it from the lab daemon.
mkdir -p "$HOME/.cache"
SHARED="$(mktemp -d "$HOME/.cache/compose-panel-lab-shared.XXXXXX")"
cleanup() {
    # DOCKER_HOST points to the lab by now; the container lives on the outer daemon.
    env -u DOCKER_HOST docker rm -fv "$NAME" >/dev/null 2>&1 || true
    # Only the directories created above.
    case "$LAB" in /tmp/compose-panel-lab.*) rm -rf -- "$LAB" ;; esac
    case "$SHARED" in "$HOME"/.cache/compose-panel-lab-shared.*) rm -rf -- "$SHARED" ;; esac
}
trap cleanup EXIT
mkdir -m 700 "$LAB/socket"

# `dind` prepares cgroups for a nested daemon, then runs dockerd as given.
docker run -d --name "$NAME" --privileged \
    -v "$LAB/socket:/lab" \
    -v "$SHARED:$SHARED" \
    --entrypoint dind "$IMAGE" \
    dockerd -H unix:///lab/docker.sock --label compose-panel-lab=1 >/dev/null

ready=0
for _ in $(seq 1 60); do
    if docker exec "$NAME" test -S /lab/docker.sock 2>/dev/null; then ready=1; break; fi
    sleep 0.5
done
if [ "$ready" -ne 1 ]; then
    echo "The lab daemon did not start:" >&2
    docker logs "$NAME" 2>&1 | tail -20 >&2
    exit 1
fi
# The directory is private to this user; let this user reach the socket.
docker exec "$NAME" chmod 666 /lab/docker.sock

unset DOCKER_CONTEXT
export DOCKER_HOST="unix://$LAB/socket/docker.sock"
for _ in $(seq 1 40); do docker info >/dev/null 2>&1 && break; sleep 0.5; done
echo "Lab daemon: $(docker info --format '{{.Name}} {{.ServerVersion}} {{json .Labels}}')"
if [ -n "$(docker ps -aq)" ]; then echo "The lab daemon is not empty; refusing." >&2; exit 1; fi

# Copy the working tree into the Linux file system (/mnt/* is not one).
mkdir "$LAB/app"
rsync -a --exclude node_modules --exclude .git --exclude private "$SRC/" "$LAB/app/"
cd "$LAB/app"
"$BUN" install --frozen-lockfile >/dev/null
# Run the two lab suites in separate, sequential processes: the toolbox test
# pulls an image, and overlapping it with the lifecycle suite can slow the
# latter's short-timeout Docker reads (a flaky "deployed" metadata read).
COMPOSE_PANEL_TEST_DOCKER_LAB=1 COMPOSE_PANEL_LAB_SHARED="$SHARED" "$BUN" test tests/docker-lifecycle-linux.test.ts
COMPOSE_PANEL_TEST_DOCKER_LAB=1 COMPOSE_PANEL_LAB_SHARED="$SHARED" "$BUN" test tests/toolbox-linux.test.ts
