#!/usr/bin/env bash
# Run one command while holding the Compose Panel Caddy lock (ADR 0030).
#
# Any other tool that edits Caddy files or reloads Caddy on this host (for
# example an external deployment pipeline) should wrap that step with this
# script, so its reload can never interleave with a panel attach/detach:
#
#   with-caddy-lock.sh caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
#   with-caddy-lock.sh /opt/deploy/update-routes.sh
#
# Protocol (same as the helper): an atomic `mkdir` of <managed dir>/.lock, then
# `<pid>:<token>` written to <lock>/owner. The helper only reclaims a lock
# whose PID is gone, so run this in the HOST PID namespace (not inside a
# container), as root or as the user owning the managed directory. This script
# never reclaims a lock itself: after CADDY_LOCK_WAIT_SECONDS it gives up and
# exits 75 without running the command. Never write into the managed
# directory from here: those files belong to the panel.
set -euo pipefail

MANAGED_DIR="${CADDY_MANAGED_DIR:-/etc/caddy/compose-panel.d}"
WAIT_SECONDS="${CADDY_LOCK_WAIT_SECONDS:-60}"
LOCK="$MANAGED_DIR/.lock"

if [ "$#" -eq 0 ]; then
    echo "Usage: with-caddy-lock.sh <command> [args...]" >&2
    exit 64
fi
if [ ! -d "$MANAGED_DIR" ] || [ -L "$MANAGED_DIR" ]; then
    echo "Managed directory not usable: $MANAGED_DIR" >&2
    exit 78
fi

deadline=$((SECONDS + WAIT_SECONDS))
until mkdir "$LOCK" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
        echo "The Caddy lock is still held ($LOCK). Nothing was run. Retry later, or remove it by hand only if its owner is gone." >&2
        exit 75
    fi
    sleep 0.2
done
token="$$:with-caddy-lock-$RANDOM$RANDOM"
# Release only our own lock, even if the command fails or we are signalled.
release() {
    if [ "$(cat "$LOCK/owner" 2>/dev/null || true)" = "$token" ]; then rm -rf "$LOCK"; fi
}
trap release EXIT
trap 'exit 130' INT TERM
printf '%s' "$token" > "$LOCK/owner"

"$@"
