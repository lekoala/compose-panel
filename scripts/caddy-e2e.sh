#!/usr/bin/env bash
# Run the Caddy helper end-to-end test against a real, disposable Caddy:
#   bun run test:caddy:wsl          # from a Windows checkout, through WSL
#   bash scripts/caddy-e2e.sh       # on a Linux machine
#
# Downloads a pinned Caddy release once into $W (nothing is installed), then
# runs tests/caddy-e2e.test.ts through scripts/test-wsl.sh with
# COMPOSE_PANEL_TEST_CADDY_BIN set. The test starts its own Caddy with random
# ports and a temp config: a Caddy already running on the host is never used.
# Needs Bun (~/.bun) and curl.
set -euo pipefail

W="${COMPOSE_PANEL_CADDY_E2E_DIR:-/tmp/compose-panel-caddy-e2e}"
CADDY_VERSION=2.8.4

mkdir -p "$W"
if [ ! -x "$W/caddy" ]; then
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" | tar -xz -C "$W" caddy
fi

COMPOSE_PANEL_TEST_CADDY_BIN="$W/caddy" bash "$(dirname "$0")/test-wsl.sh" tests/caddy-e2e.test.ts tests/caddy-helper.test.ts "$@"
