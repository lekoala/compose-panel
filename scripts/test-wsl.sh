#!/usr/bin/env bash
# Run the test suite and typecheck on Linux from a Windows checkout, through WSL:
#   bun run test:wsl                      # everything
#   bun run test:wsl tests/editor.test.ts # extra arguments go to `bun test`
#
# Windows Bun is not proof of Linux behavior (signals, symlinks, file modes), so
# the working tree, including uncommitted changes, is copied into the Linux file
# system first: /mnt/* does not behave like a Linux file system.
#
# Safe on a host daemon: the Docker integration test stays disabled and the
# Compose test only runs `docker compose config` against fixtures.
# Requires Bun in WSL: curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"
set -euo pipefail

BUN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
DEST="${COMPOSE_PANEL_WSL_DIR:-/tmp/compose-panel-test}"

if [ ! -x "$BUN" ]; then
    echo "Bun not found at $BUN. Install it in WSL first:" >&2
    echo '  curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"' >&2
    exit 1
fi

mkdir -p "$DEST"
rsync -a --delete --exclude node_modules --exclude .git --exclude private ./ "$DEST/"
cd "$DEST"

"$BUN" install --frozen-lockfile >/dev/null
COMPOSE_PANEL_TEST_DOCKER=0 COMPOSE_PANEL_TEST_COMPOSE_CONFIG=1 "$BUN" test "$@"
"$BUN" check
