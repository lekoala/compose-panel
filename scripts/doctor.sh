#!/usr/bin/env bash
# Read-only host diagnostics: sudo bash scripts/doctor.sh [--production]
# Exit 0: checked services healthy; 1: failure; 2: external access unverified.
# No package changes, transient systemd units, reloads, pulls or deployments.
set +x
set -euo pipefail

doctor_probe() {
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then
        printf '  ok    %s\n' "$label"
        return 0
    fi
    printf '  FAIL  %s\n' "$label"
    doctor_failures=$((doctor_failures + 1))
    return 0
}

doctor_secret_file() {
    plain_path "$ENV_FILE" && [ -f "$ENV_FILE" ] && [ "$(stat -c '%u %a' "$ENV_FILE")" = '0 600' ]
}

# The port the container actually uses (PORT in its environment, as setup-caddy.sh reads it).
doctor_port() {
    local port
    port="$(timeout 15 docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | sed -n 's/^PORT=//p' | tail -n 1)"
    [[ "${port:-5081}" =~ ^[0-9]{1,5}$ ]] || return 1
    printf '%s\n' "${port:-5081}"
}

doctor_health() {
    local port
    port="$(doctor_port)" || return 1
    [ "$(timeout 15 docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER")" = healthy ] &&
        curl --noproxy '*' -fsS --max-time 5 "http://127.0.0.1:$port/health/live" >/dev/null
}

doctor_mount() {
    timeout 15 docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/compose-panel"}}{{.Type}} {{.Source}} {{.RW}}{{end}}{{end}}' "$CONTAINER" |
        grep -x 'bind /run/compose-panel false'
}

doctor_https() {
    local origins origin status expected='200|401'
    origins="$(env_value "$ENV_FILE" COMPOSE_PANEL_PROXY_ORIGINS)"
    # An installer deployment puts Basic Auth in front of every route: 200 would
    # mean the panel is exposed without it.
    [ -z "$(env_value "$ENV_FILE" COMPOSE_PANEL_INSTALLER_PROXY_HASH)" ] || expected=401
    if [ -z "$origins" ]; then
        printf '  skip  No HTTPS origin configured; use the SSH tunnel.\n'
        return 0
    fi
    local -a entries
    IFS=, read -ra entries <<< "$origins"
    for origin in "${entries[@]}"; do
        # No credentials, paths, query strings, shell syntax or curl options.
        if [[ ! "$origin" =~ ^https://([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}(:[0-9]{1,5})?$ ]]; then
            doctor_failures=$((doctor_failures + 1))
            printf '  FAIL  Unsupported HTTPS origin; inspect settings locally.\n'
            continue
        fi
        status="$(curl --noproxy '*' --proto '=https' -sS --connect-timeout 5 --max-time 10 \
            -o /dev/null -w '%{http_code}' "$origin/login" 2>/dev/null || true)"
        if [[ "$status" =~ ^($expected)$ ]]; then
            printf '  ok    TLS and login endpoint reachable from this host: %s\n' "$origin"
            printf '  note  Authenticated login and access from another network are not checked.\n'
            continue
        fi
        case "$status" in
            200)
                doctor_failures=$((doctor_failures + 1))
                printf '  FAIL  %s answers without the installer Basic Auth; check the Caddyfile.\n' "$origin"
                ;;
            *)
                doctor_unverified=1
                printf '  WARN  HTTPS unverified: %s (check DNS, certificates and firewall).\n' "$origin"
                ;;
        esac
    done
}

doctor_checks() {
    doctor_failures=0 doctor_unverified=0
    doctor_probe "Local Docker Engine" timeout 15 docker info
    doctor_probe "Docker Compose plugin" timeout 15 docker compose version
    for service in docker caddy caddy-helper.socket; do
        doctor_probe "$service active" timeout 15 systemctl is-active --quiet "$service"
        doctor_probe "$service enabled at boot" timeout 15 systemctl is-enabled --quiet "$service"
    done
    doctor_probe "Settings are a regular root-owned 0600 file without symlink parents" doctor_secret_file
    if panel_identity_matches; then
        printf '  ok    Panel belongs to this checkout and selected Compose file.\n'
        doctor_probe "Container health and loopback HTTP endpoint" doctor_health
        doctor_probe "Helper directory mounted read-only at the expected host path" doctor_mount
        doctor_probe "Helper status, import and managed site files" helper_status_ok
    else
        doctor_failures=$((doctor_failures + 1))
        printf '  FAIL  Panel identity mismatch or unavailable; container execution skipped.\n'
    fi
    # `validate` can provision storage. `adapt` only parses: safe for diagnosis,
    # but deliberately does not claim to reproduce systemd sandbox validation.
    doctor_probe "Caddyfile parses (adapt only, no provisioning)" timeout 20 runuser -u caddy -- \
        caddy adapt --config "$CADDYFILE" --adapter caddyfile
    printf '  note  Runtime sandbox validation is performed by setup-caddy.sh --install, not this read-only doctor.\n'
    if doctor_secret_file; then doctor_https; fi
    [ "$doctor_failures" -eq 0 ] || return 1
    [ "$doctor_unverified" -eq 0 ] || return 2
}

if [ "${COMPOSE_PANEL_DOCTOR_LIB:-}" = 1 ]; then return 0; fi

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
COMPOSE_FILE="$REPO/deploy/compose.yaml"
for arg in "$@"; do
    case "$arg" in
        --production) COMPOSE_FILE="$REPO/deploy/compose.prod.yaml" ;;
        -h|--help) sed -n '2,4p' "$0" | sed 's/^# //'; exit 0 ;;
        *) printf 'Unknown option: %s\n' "$arg" >&2; exit 64 ;;
    esac
done
if [ "$(uname -s)" != Linux ] || [ "$(id -u)" != 0 ]; then
    echo "Run as root on the Linux deployment host." >&2
    exit 1
fi
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST=unix:///var/run/docker.sock
COMPOSE_PANEL_SETUP_LIB=1 source "$REPO/scripts/setup-caddy.sh"
COMPOSE_PANEL_INSTALL_LIB=1 source "$REPO/scripts/install.sh"
ENV_FILE="$REPO/deploy/compose-panel.env"
echo "Compose Panel — read-only diagnostics"
doctor_checks
