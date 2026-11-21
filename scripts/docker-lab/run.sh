#!/usr/bin/env bash
# Opt-in lifecycle test (tests/docker-lifecycle-linux.test.ts) on a disposable
# Docker-in-Docker daemon:
#   bun run test:docker-lab:wsl        # from Windows, through WSL
#   bash scripts/docker-lab/run.sh     # on a Linux dev machine or disposable VM
# Extra arguments select Bun test files/options inside the same guarded lab.
#
# The lab daemon comes from scripts/docker-lab/lib.sh: a PRIVILEGED docker:dind
# container on the current daemon, with its own Docker resources, not the
# isolation of a VM. Run it only on a development machine or a throwaway VM,
# never on a server running real stacks. The lab daemon listens on a Unix
# socket in a private directory, carries the engine label compose-panel-lab=1
# checked by the test, and is removed with its storage on exit. Existing
# containers are never touched.
# Needs Docker with the Compose plugin, rsync, and Bun in ~/.bun.
set -euo pipefail

SRC="$(pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
IMAGE="${COMPOSE_PANEL_LAB_IMAGE:-docker:29.9.0-dind}"
NAME="compose-panel-lab-$$"

if [ ! -x "$BUN" ]; then
    echo "Bun not found at $BUN. Install it first:" >&2
    echo '  curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.5"' >&2
    exit 1
fi

source "$HERE/lib.sh"
LAB_NAME="$NAME"
LAB_IMAGE="$IMAGE"
# The remote image check (ADR 0041) runs the buildx client in this process, not
# in the lab daemon, so the lab registry must also be reachable on this host's
# loopback. The suite publishes the registry itself on 5030 inside the lab; this
# mapping carries it out, keeping one reference valid on both sides.
LAB_PUBLISH="127.0.0.1:5030:5030"
trap lab_on_exit EXIT
lab_start

# Seed the lab daemon from the outer daemon's cache. A suite that only needs
# these base images must not fail because Docker Hub is rate-limiting an
# unrelated pull, and `docker pull` revalidates against the registry even when
# the image is already there — so the images have to be present before the
# suites run. Best effort: a cold machine still pulls them at test time.
lab_seed_from_cache "${COMPOSE_PANEL_LAB_BASE_IMAGE:-alpine:3.20}" "${COMPOSE_PANEL_LAB_REGISTRY_IMAGE:-registry:2}"

# Copy the working tree into the Linux file system (/mnt/* is not one).
mkdir "$LAB_DIR/app"
rsync -a --exclude node_modules --exclude .git --exclude private "$SRC/" "$LAB_DIR/app/"
cd "$LAB_DIR/app"
"$BUN" install --frozen-lockfile >/dev/null
# Run the two lab suites in separate, sequential processes: the toolbox test
# pulls an image, and overlapping it with the lifecycle suite can slow the
# latter's short-timeout Docker reads (a flaky "deployed" metadata read).
if [ "$#" -gt 0 ]; then
    COMPOSE_PANEL_TEST_DOCKER_LAB=1 COMPOSE_PANEL_LAB_SHARED="$LAB_SHARED" "$BUN" test "$@"
else
    COMPOSE_PANEL_TEST_DOCKER_LAB=1 COMPOSE_PANEL_LAB_SHARED="$LAB_SHARED" "$BUN" test tests/docker-lifecycle-linux.test.ts
    COMPOSE_PANEL_TEST_DOCKER_LAB=1 COMPOSE_PANEL_LAB_SHARED="$LAB_SHARED" "$BUN" test tests/toolbox-linux.test.ts
    COMPOSE_PANEL_TEST_DOCKER_LAB=1 COMPOSE_PANEL_LAB_SHARED="$LAB_SHARED" "$BUN" test tests/maintenance-linux.test.ts
fi
