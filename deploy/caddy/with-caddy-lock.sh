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
LOCK_TOKEN=""

acquire_caddy_lock() {
    local deadline
    LOCK="$MANAGED_DIR/.lock"
    if [ ! -d "$MANAGED_DIR" ] || [ -L "$MANAGED_DIR" ]; then
        echo "Managed directory not usable: $MANAGED_DIR" >&2
        return 78
    fi
    [[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || return 64
    deadline=$((SECONDS + WAIT_SECONDS))
    until mkdir -m 0755 "$LOCK" 2>/dev/null; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            echo "The Caddy lock is still held. Nothing was changed by this step." >&2
            return 75
        fi
        sleep 0.2
    done
    LOCK_TOKEN="$$:with-caddy-lock-$RANDOM$RANDOM"
    # A root-run setup must leave a dead lock reclaimable by the caddy user,
    # even when the installer uses umask 077.
    if [ "$(id -u)" = 0 ] && ! chown --reference="$MANAGED_DIR" "$LOCK"; then
        rmdir "$LOCK"
        LOCK_TOKEN=""
        return 1
    fi
    if ! printf '%s' "$LOCK_TOKEN" > "$LOCK/owner" || ! chmod 0644 "$LOCK/owner"; then
        rm -f "$LOCK/owner"
        rmdir "$LOCK"
        LOCK_TOKEN=""
        return 1
    fi
}

release_caddy_lock() {
    if [ -n "$LOCK_TOKEN" ] && [ "$(cat "$LOCK/owner" 2>/dev/null || true)" = "$LOCK_TOKEN" ]; then
        rm -f "$LOCK/owner"
        rmdir "$LOCK"
    fi
    LOCK_TOKEN=""
}

if [ "${COMPOSE_PANEL_CADDY_LOCK_LIB:-}" = 1 ]; then
    return 0
fi
if [ "$#" -eq 0 ]; then
    echo "Usage: with-caddy-lock.sh <command> [args...]" >&2
    exit 64
fi
trap release_caddy_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT TERM
acquire_caddy_lock

"$@"
