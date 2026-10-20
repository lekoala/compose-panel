#!/usr/bin/env bash
# One-command host setup for the optional Caddy site management (ADR 0030).
#
#   sudo bash scripts/setup-caddy.sh --check      # read-only: what is there, what would change
#   sudo bash scripts/setup-caddy.sh --install    # apply, after an explicit confirmation
#   sudo bash scripts/setup-caddy.sh --install --yes   # same, no prompt (automation)
#
# Run it on the host, from the Compose Panel checkout used to deploy the panel
# (deploy/compose.yaml, or --production for deploy/compose.prod.yaml).
# It supports the documented layout and refuses anything
# else instead of guessing:
#   - Caddy installed on the host as the systemd service `caddy`, running
#     `--config /etc/caddy/Caddyfile`, with its administration API enabled.
#     A Caddy running in a Docker container is NOT supported by the helper.
#   - The panel deployed with deploy/compose.yaml (container `compose-panel`),
#     which mounts /run/compose-panel read-only.
#
# --install preserves settings and image, but rebuilds and recreates:
#   1. /etc/caddy/compose-panel.d owned by caddy (0755).
#   2. The helper binary compiled from the panel image that is running now
#      (same version, host architecture; no Bun on the host, no download),
#      installed to /usr/local/bin/compose-panel-caddy-helper.
#   3. The systemd socket + service units from deploy/caddy/, socket enabled.
#   4. `import /etc/caddy/compose-panel.d/*.caddy` appended to the Caddyfile
#      (backup first, `caddy validate`, then `systemctl reload caddy`; the
#      backup is restored if either fails).
#   5. COMPOSE_PANEL_CADDY_ENABLED / COMPOSE_PANEL_CADDY_SOCKET_PATH set in
#      deploy/compose-panel.env (backup first).
#   6. The panel recreated, then checked: healthy, socket mounted, helper
#      answering from inside the container. A panel that does not come back
#      healthy gets its previous compose-panel.env back and is recreated again.
#
# Re-run --install after updating the panel image: it recompiles the helper
# from the new image, so both sides keep speaking the same protocol.
# Guard chains intentionally report any failed check; library mode can be
# sourced or invoked directly.
# shellcheck disable=SC2015,SC2317
set -euo pipefail

MANAGED_DIR=/etc/caddy/compose-panel.d
CADDYFILE=/etc/caddy/Caddyfile
SOCKET_DIR=/run/compose-panel
SOCKET_PATH=$SOCKET_DIR/caddy-helper.sock
HELPER_BIN=/usr/local/bin/compose-panel-caddy-helper
SYSTEMD_DIR=/etc/systemd/system
IMPORT_LINE="import $MANAGED_DIR/*.caddy"
CONTAINER=compose-panel

# ---------------------------------------------------------------------------
# File helpers (pure: no systemd, no Docker). Sourced by the tests with
# COMPOSE_PANEL_SETUP_LIB=1.
# ---------------------------------------------------------------------------

# Print `present`, `absent` or `conflict` for the managed import in a
# Caddyfile. `conflict` is another import of the managed directory (for
# example `/*`, which would also load the helper's temporary files).
caddy_import_state() {
    local file="$1" dir="$2" line target state=absent
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%%#*}"
        line="$(printf '%s' "$line" | tr -s ' \t' ' ' | sed 's/^ //; s/ $//')"
        case "$line" in
            "import "*) ;;
            *) continue ;;
        esac
        target="${line#import }"
        target="${target#\"}"; target="${target%\"}"
        target="${target#\'}"; target="${target%\'}"
        if [ "$target" = "$dir/*.caddy" ]; then
            state=present
        elif [ "${target#"$dir"/}" != "$target" ] || [ "$target" = "$dir" ]; then
            printf 'conflict\n'
            return 0
        fi
    done < "$file"
    printf '%s\n' "$state"
}

# Append the managed import at the end of a Caddyfile (top level). Only called
# when caddy_import_state says `absent`.
append_caddy_import() {
    local file="$1" dir="$2"
    # Make sure the file ends with a newline before appending.
    if [ -s "$file" ] && [ "$(tail -c 1 "$file" | od -An -c | tr -d ' ')" != '\n' ]; then
        printf '\n' >> "$file"
    fi
    printf '\n# Compose Panel managed sites (ADR 0030). Added by scripts/setup-caddy.sh.\nimport %s/*.caddy\n' "$dir" >> "$file"
}

# Value of KEY in an env file (last assignment wins, surrounding quotes
# removed), or nothing when unset. Commented lines are ignored.
env_value() {
    local file="$1" key="$2"
    [ -f "$file" ] || return 0
    sed -n "s/^[[:space:]]*$key=//p" "$file" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/; s/^\"\(.*\)\"\$/\1/"
}

# Print `ok` when every KEY=VALUE pair is already set, `missing` when some keys
# are unset, `conflict` when one is set to another value.
env_state() {
    local file="$1"; shift
    local pair key want have state=ok
    for pair in "$@"; do
        key="${pair%%=*}"; want="${pair#*=}"
        have="$(env_value "$file" "$key")"
        if [ -z "$have" ]; then
            state=missing
        elif [ "$have" != "$want" ]; then
            printf 'conflict\n'
            return 0
        fi
    done
    printf '%s\n' "$state"
}

# Append the KEY=VALUE pairs that are not set yet. Never rewrites a line.
ensure_env() {
    local file="$1"; shift
    local pair key added=0
    for pair in "$@"; do
        key="${pair%%=*}"
        if [ -z "$(env_value "$file" "$key")" ]; then
            if [ "$added" -eq 0 ]; then
                [ -s "$file" ] && [ "$(tail -c 1 "$file" | od -An -c | tr -d ' ')" != '\n' ] && printf '\n' >> "$file"
                printf '# Caddy site management (ADR 0030). Added by scripts/setup-caddy.sh.\n' >> "$file"
                added=1
            fi
            printf '%s\n' "$pair" >> "$file"
        fi
    done
}

# Only the documented, single-file deployment from this checkout is supported.
# Labels are checked before any host changes, never inferred from the name.
panel_identity_matches() {
    local project service directory files oneoff env_files
    project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER")" || return 1
    service="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$CONTAINER")" || return 1
    directory="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$CONTAINER")" || return 1
    files="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$CONTAINER")" || return 1
    oneoff="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.oneoff"}}' "$CONTAINER")" || return 1
    env_files="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.environment_file"}}' "$CONTAINER")" || return 1
    [ "$project" = compose-panel ] && [ "$service" = panel ] &&
        [ "$directory" = "$REPO/deploy" ] && [ "$files" = "$COMPOSE_FILE" ] &&
        [ "$oneoff" = False ] || return 1
    # This layout uses env_file: compose-panel.env, not a CLI interpolation file.
    case "$env_files" in ''|'<no value>') ;; *) return 1 ;; esac
    [ ! -e "$REPO/deploy/.env" ] && [ ! -L "$REPO/deploy/.env" ]
}

panel_compose() {
    # Disable implicit .env discovery and inherited Compose control variables.
    timeout --kill-after=10 600 env -u COMPOSE_FILE -u COMPOSE_ENV_FILES -u COMPOSE_PROFILES COMPOSE_DISABLE_ENV_FILE=true \
        docker compose -p compose-panel --project-directory "$REPO/deploy" \
        -f "$COMPOSE_FILE" "$@"
}

# Preserve Config.Image and Compose labels (needed by About's updater). Pin the
# tag to the running image for the duration of up, then restore the cached tag,
# including on command failure. Do not overwrite a tag changed by another writer.
restore_panel_tag() {
    [ -n "${saved_tag_image:-}" ] || return 0
    local current
    current="$(docker image inspect -f '{{.Id}}' "$panel_image_ref")" || return 1
    if [ "$current" != "$panel_image" ]; then
        echo "The panel image tag changed concurrently; refusing to overwrite it." >&2
        return 1
    fi
    docker image tag "$saved_tag_image" "$panel_image_ref" || return 1
    saved_tag_image=""
}

recreate_panel() {
    local result=0
    [ -z "${saved_tag_image:-}" ] || restore_panel_tag || return 1
    saved_tag_image="$(docker image inspect -f '{{.Id}}' "$panel_image_ref")" || return 1
    docker image tag "$panel_image" "$panel_image_ref" || return 1
    panel_compose up -d --no-deps --no-build --pull never panel || result=$?
    restore_panel_tag || return 1
    return "$result"
}

# A nonzero up and an unhealthy container share the same rollback path.
recreate_and_verify_panel() {
    if recreate_panel && wait_healthy; then return 0; fi
    if [ -n "$env_backup" ]; then
        cp -p "$env_backup" "$ENV_FILE" || return 1
        if recreate_panel && wait_healthy; then
            echo "Panel settings restored and rollback is healthy." >&2
        else
            echo "Panel settings restored, but rollback failed or remains unhealthy. Check Docker before retrying." >&2
        fi
    fi
    return 1
}

# Replace an existing regular file by rename on the same filesystem. Copying
# the source preserves its owner/mode, including during rollback.
atomic_host_file() {
    local source="$1" target="$2" staged parent
    parent="$(dirname "$target")"
    while [ "$parent" != / ]; do
        [ ! -L "$parent" ] || return 1
        parent="$(dirname "$parent")"
    done
    [ ! -L "$target" ] && { [ ! -e "$target" ] || [ -f "$target" ]; } || return 1
    staged="$(mktemp "$(dirname "$target")/.cp-host.XXXXXX")" || return 1
    if ! cp -p "$source" "$staged" || ! mv -fT "$staged" "$target"; then
        rm -f "$staged"
        return 1
    fi
}

# Print a backup of the current helper binary, only once the copy is complete:
# the EXIT trap restores it, so a failed copy must never become that source.
backup_helper() {
    local backup
    backup="$(mktemp "$HELPER_BIN.bak-XXXXXX")" || return 1
    if cp -p "$HELPER_BIN" "$backup" && cmp -s "$HELPER_BIN" "$backup"; then
        printf '%s\n' "$backup"
        return 0
    fi
    rm -f "$backup"
    return 1
}

caddy_validate_as_caddy() {
    timeout --kill-after=5 30 runuser -u caddy -- env HOME="$(getent passwd caddy | cut -d: -f6)" \
        caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1
}

caddy_validate_sandbox() {
    timeout --kill-after=5 45 systemd-run --quiet --pipe --wait --collect \
        -p RuntimeMaxSec=30 -p User=caddy -p Group=caddy -p ProtectSystem=strict -p ProtectHome=yes \
        -p PrivateTmp=yes -p NoNewPrivileges=yes -p ReadWritePaths="$MANAGED_DIR" \
        caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1
}

caddy_reload() { timeout --kill-after=5 45 systemctl reload caddy; }

# The caller holds the shared Caddy lock for publication, validation AND rollback.
# A pending backup also lets the caller's signal/EXIT trap restore the file.
caddy_rollback() {
    [ -n "${caddy_pending_backup:-}" ] || return 0
    if ! atomic_host_file "$caddy_pending_backup" "$CADDYFILE"; then
        echo "Caddyfile restoration failed; inspect the retained backup. Outcome unknown." >&2
        return 2
    fi
    if ! caddy_reload; then
        echo "Caddyfile restored, but its reload failed. Running configuration unknown." >&2
        return 2
    fi
    caddy_pending_backup=""
    echo "Previous Caddyfile restored and reloaded." >&2
}

caddy_apply_candidate() {
    local candidate="$1" result=1
    [ -f "$CADDYFILE" ] && [ ! -L "$CADDYFILE" ] || return 1
    caddy_pending_backup="$(mktemp "$CADDYFILE.bak-setup.XXXXXX")" || return 1
    if ! cp -p "$CADDYFILE" "$caddy_pending_backup"; then caddy_pending_backup=""; return 1; fi
    printf 'Caddyfile backup: %s\n' "$caddy_pending_backup"
    if atomic_host_file "$candidate" "$CADDYFILE" &&
        caddy_validate_as_caddy && caddy_validate_sandbox && caddy_reload; then
        caddy_pending_backup=""
        return 0
    fi
    caddy_rollback || result=2
    return "$result"
}

helper_status_ok() {
    # Status only reads files. Never print a helper response (it may name sites).
    timeout --kill-after=5 20 docker exec "$CONTAINER" bun -e '
const { callCaddyHelper } = await import("/app/src/caddy-client.ts");
const r = await callCaddyHelper("/run/compose-panel/caddy-helper.sock", {action:"status"}, {timeoutMs:10000});
process.exit(r.ok && r.importConfigured && r.unparseable.length === 0 ? 0 : 1);
' >/dev/null 2>&1
}

if [ "${COMPOSE_PANEL_SETUP_LIB:-}" = 1 ]; then
    return 0 2>/dev/null || exit 0
fi

# ---------------------------------------------------------------------------
# Host checks and installation.
# ---------------------------------------------------------------------------

REPO="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_PANEL_CADDY_LOCK_LIB=1 CADDY_MANAGED_DIR="$MANAGED_DIR" source "$REPO/deploy/caddy/with-caddy-lock.sh"
COMPOSE_FILE="$REPO/deploy/compose.yaml"
ENV_FILE="$REPO/deploy/compose-panel.env"
ENV_PAIRS=("COMPOSE_PANEL_CADDY_ENABLED=true" "COMPOSE_PANEL_CADDY_SOCKET_PATH=$SOCKET_PATH")

MODE=""
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        --check) MODE=check ;;
        --install) MODE=install ;;
        --yes) ASSUME_YES=1 ;;
        --production) COMPOSE_FILE="$REPO/deploy/compose.prod.yaml" ;;
        -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $arg (use --check or --install)" >&2; exit 64 ;;
    esac
done
if [ -z "$MODE" ]; then
    echo "Usage: sudo bash scripts/setup-caddy.sh --check | --install [--yes] [--production]" >&2
    exit 64
fi

problems=0
plan=()
ok() { printf '  ok    %s\n' "$1"; }
todo() { printf '  todo  %s\n' "$1"; plan+=("$1"); }
bad() { printf '  FAIL  %s\n' "$1"; problems=$((problems + 1)); }
die() { printf '\nStopped: %s\n' "$1" >&2; exit 1; }

echo "Compose Panel — Caddy site management setup ($MODE)"
echo
echo "Host:"
[ "$(uname -s)" = Linux ] && ok "Linux" || bad "Not Linux: the helper only runs on a Linux host."
[ "$(id -u)" -eq 0 ] && ok "running as root" || bad "Run as root (sudo): systemd units, /etc/caddy and Docker need it."
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] && ok "systemd" || bad "systemd is required for the helper socket."
command -v docker >/dev/null 2>&1 && ok "docker CLI" || bad "docker CLI not found."
command -v curl >/dev/null 2>&1 && ok "curl" || bad "curl not found (used to check the panel health)."

echo
echo "Caddy:"
if command -v caddy >/dev/null 2>&1 && systemctl cat caddy.service >/dev/null 2>&1; then
    ok "host Caddy ($(caddy version 2>/dev/null | cut -d' ' -f1)), systemd service caddy"
    if systemctl is-active --quiet caddy; then ok "caddy service active"; else bad "The caddy service is not running."; fi
    if systemctl show caddy -p ExecStart --value 2>/dev/null | grep -- "--config $CADDYFILE" >/dev/null; then
        ok "caddy runs $CADDYFILE"
    else
        bad "The caddy service does not run --config $CADDYFILE. Only that layout is supported; see docs/deployment.md for a manual setup."
    fi
else
    if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Image}} {{.Names}}' 2>/dev/null | grep -i caddy >/dev/null; then
        bad "Caddy runs in a Docker container here. The helper targets a host Caddy (systemd) and is not supported for this layout."
    else
        bad "No host Caddy found (binary 'caddy' and systemd service 'caddy')."
    fi
fi
id caddy >/dev/null 2>&1 && ok "user caddy" || bad "User 'caddy' not found (created by the Caddy package)."
caddy_import=unknown
if [ -f "$CADDYFILE" ] && [ ! -L "$CADDYFILE" ]; then
    if grep -Eq '^[[:space:]]*admin[[:space:]]+off' "$CADDYFILE"; then
        bad "$CADDYFILE disables the administration API (admin off): caddy reload needs it."
    fi
    caddy_import="$(caddy_import_state "$CADDYFILE" "$MANAGED_DIR")"
    case "$caddy_import" in
        present) ok "$CADDYFILE imports $MANAGED_DIR/*.caddy" ;;
        absent) todo "append '$IMPORT_LINE' to $CADDYFILE (backup, validate, reload)" ;;
        conflict) bad "$CADDYFILE imports $MANAGED_DIR with another pattern. Use exactly '$IMPORT_LINE'." ;;
    esac
else
    bad "$CADDYFILE is missing or a symbolic link."
fi
if [ -L "$MANAGED_DIR" ] || { [ -e "$MANAGED_DIR" ] && [ ! -d "$MANAGED_DIR" ]; }; then
    bad "$MANAGED_DIR exists but is not a plain directory."
elif [ -d "$MANAGED_DIR" ] && [ "$(stat -c '%U %a' "$MANAGED_DIR")" = "caddy 755" ]; then
    ok "$MANAGED_DIR (caddy, 0755)"
else
    todo "create $MANAGED_DIR owned by caddy (0755)"
fi

echo
echo "Helper:"
for unit in caddy-helper.socket caddy-helper@.service; do
    if [ ! -f "$REPO/deploy/caddy/$unit" ]; then
        bad "deploy/caddy/$unit missing: run this script from the Compose Panel checkout."
    elif cmp -s "$REPO/deploy/caddy/$unit" "$SYSTEMD_DIR/$unit"; then
        ok "$SYSTEMD_DIR/$unit up to date"
    else
        todo "install $SYSTEMD_DIR/$unit"
    fi
done
if systemctl is-active --quiet caddy-helper.socket 2>/dev/null; then ok "caddy-helper.socket active"; else todo "enable and start caddy-helper.socket"; fi
todo "compile the helper from the running panel image and install $HELPER_BIN"

echo
echo "Panel:"
panel_image=""
panel_port=5081
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    if panel_identity_matches; then
        ok "container belongs to this checkout's Compose deployment"
    else
        bad "Container $CONTAINER does not match this checkout's single-file Compose deployment (including interpolation files)."
    fi
    panel_image="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
    panel_image_ref="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
    if [[ ! "$panel_image" =~ ^sha256:[0-9a-f]{64}$ ]] ||
        [[ ! "$panel_image_ref" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:+-]*$ ]] ||
        [[ "$panel_image_ref" == sha256:* ]]; then
        bad "The panel must use a tagged image with a valid running image ID."
    elif [ "$(panel_compose config --images panel 2>/dev/null)" != "$panel_image_ref" ]; then
        bad "The Compose panel image differs from the running container's image reference."
    elif ! docker image inspect "$panel_image_ref" >/dev/null 2>&1; then
        bad "The panel image tag is missing locally; restore it before running setup."
    fi
    panel_port="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | sed -n 's/^PORT=//p' | tail -n 1)"
    panel_port="${panel_port:-5081}"
    ok "container $CONTAINER ($(docker inspect -f '{{.Config.Image}}' "$CONTAINER"))"
else
    bad "Container $CONTAINER not found: deploy the panel first (docs/deployment.md)."
fi
[ -f "$COMPOSE_FILE" ] && ok "$COMPOSE_FILE" || bad "$COMPOSE_FILE missing."
if [ -f "$COMPOSE_FILE" ] && grep -Eq "^[[:space:]]*-[[:space:]]*$SOCKET_DIR:$SOCKET_DIR(:ro)?[[:space:]]*$" "$COMPOSE_FILE"; then
    ok "compose.yaml mounts $SOCKET_DIR"
else
    bad "$COMPOSE_FILE does not mount $SOCKET_DIR:$SOCKET_DIR:ro. Update the checkout (git pull) or add that volume."
fi
if [ ! -f "$ENV_FILE" ]; then
    bad "$ENV_FILE missing."
else
    case "$(env_state "$ENV_FILE" "${ENV_PAIRS[@]}")" in
        ok) ok "compose-panel.env enables the integration" ;;
        missing) todo "set ${ENV_PAIRS[*]} in compose-panel.env (backup first)" ;;
        conflict) bad "compose-panel.env sets COMPOSE_PANEL_CADDY_* to other values. Fix them by hand: ${ENV_PAIRS[*]}." ;;
    esac
fi
todo "recreate the panel and verify the helper from inside it"

echo
if [ "$problems" -gt 0 ]; then
    die "$problems check(s) failed. Nothing was changed."
fi
if [ "$MODE" = check ]; then
    echo "All checks passed. --install would:"
    printf '  - %s\n' "${plan[@]}"
    exit 0
fi

echo "This will:"
printf '  - %s\n' "${plan[@]}"
if [ "$ASSUME_YES" -ne 1 ]; then
    [ -t 0 ] || die "no terminal to confirm: re-run with --yes to apply without a prompt."
    read -rp "Modify $CADDYFILE, the systemd units and the panel as listed? Type 'yes': " answer
    [ "$answer" = yes ] || die "not confirmed. Nothing was changed."
fi
stamp="$(date +%Y%m%d-%H%M%S)"

echo
echo "1/6 Managed directory"
install -d -o caddy -g caddy -m 0755 "$MANAGED_DIR"

echo "2/6 Helper binary (from the panel image $panel_image)"
build_dir="$(mktemp -d)"
saved_tag_image=""
helper_backup=""
caddy_pending_backup=""
setup_cleanup() {
    local result=$?
    restore_panel_tag || result=2
    caddy_rollback || result=2
    if [ "$result" -ne 0 ] && [ -n "$helper_backup" ]; then
        atomic_host_file "$helper_backup" "$HELPER_BIN" || result=2
    fi
    release_caddy_lock || result=2
    rm -rf "$build_dir"
    exit "$result"
}
trap setup_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
timeout --kill-after=10 600 docker run --rm --network none --entrypoint bun -v "$build_dir:/out" "$panel_image" \
    build --compile src/scripts/caddy-helper.ts --outfile /out/compose-panel-caddy-helper >/dev/null
chmod 0755 "$build_dir/compose-panel-caddy-helper"
acquire_caddy_lock || die "Caddy is busy; no helper or Caddyfile was replaced."
if [ -f "$HELPER_BIN" ] && ! cmp -s "$build_dir/compose-panel-caddy-helper" "$HELPER_BIN"; then
    helper_backup="$(backup_helper)" || die "Cannot back up the current helper; nothing was replaced."
fi
atomic_host_file "$build_dir/compose-panel-caddy-helper" "$HELPER_BIN"

echo "3/6 systemd units"
install -m 0644 "$REPO/deploy/caddy/caddy-helper.socket" "$SYSTEMD_DIR/caddy-helper.socket"
install -m 0644 "$REPO/deploy/caddy/caddy-helper@.service" "$SYSTEMD_DIR/caddy-helper@.service"
timeout --kill-after=5 120 systemctl daemon-reload
# The directory may predate the socket unit (created by Docker for the panel
# mount, 0755): keep it root-only, like the unit's DirectoryMode.
install -d -m 0750 "$SOCKET_DIR"
timeout --kill-after=5 120 systemctl enable --now caddy-helper.socket >/dev/null
timeout --kill-after=5 120 systemctl restart caddy-helper.socket
[ -S "$SOCKET_PATH" ] || die "the helper socket $SOCKET_PATH did not appear (systemctl status caddy-helper.socket)."

echo "4/6 Caddyfile import"
# Re-read under the lock: the preflight was only a snapshot.
case "$(caddy_import_state "$CADDYFILE" "$MANAGED_DIR")" in
    absent)
        cp -p "$CADDYFILE" "$build_dir/Caddyfile"
        append_caddy_import "$build_dir/Caddyfile" "$MANAGED_DIR"
        caddy_apply_candidate "$build_dir/Caddyfile" || die "Caddy setup failed; inspect the rollback result above."
        ;;
    present)
        caddy_validate_as_caddy && caddy_validate_sandbox ||
            die "Caddy cannot validate in the helper sandbox. Site management is not ready."
        ;;
    *) die "The Caddy import changed concurrently; nothing was appended." ;;
esac
release_caddy_lock

echo "5/6 Panel settings"
env_backup=""
if [ "$(env_state "$ENV_FILE" "${ENV_PAIRS[@]}")" = missing ]; then
    env_backup="$ENV_FILE.bak-$stamp"
    cp -p "$ENV_FILE" "$env_backup"
    ensure_env "$ENV_FILE" "${ENV_PAIRS[@]}"
    echo "    settings added (backup: $env_backup)"
else
    echo "    already set"
fi

echo "6/6 Recreate and verify the panel"
wait_healthy() {
    local i
    for ((i = 0; i < 60; i++)); do
        if curl --noproxy '*' -fsS --max-time 3 "http://127.0.0.1:$panel_port/health/live" >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    return 1
}
recreate_and_verify_panel || die "panel recreation or health verification failed. Check: docker logs $CONTAINER"
docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$CONTAINER" | grep -w "$SOCKET_DIR" >/dev/null \
    || die "the panel container does not mount $SOCKET_DIR. Check $COMPOSE_FILE."
helper_status_ok || die "Helper status failed or managed site files are unparseable. Site management is not ready."

echo
echo "Done. Open a stack page: the Domains card can attach a domain now."
echo "After a panel image update, run this script again to rebuild the helper."
