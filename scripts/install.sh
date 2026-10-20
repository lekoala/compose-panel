#!/usr/bin/env bash
# Install Compose Panel on Ubuntu Server 24.04/26.04, amd64/arm64 (ADR 0031).
# sudo bash scripts/install.sh [--check | --install] [--yes]
# --check is read-only; --yes skips confirmation, not credential prompts.
# Guard chains deliberately fail when any check fails; library mode supports
# both sourcing and direct invocation.
# shellcheck disable=SC2015,SC2317
set +x
set -euo pipefail

installer_die() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
installed() { [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" = 'install ok installed' ]; }

supported_host() {
    [ "$1" = ubuntu ] && { [ "$2" = 24.04 ] || [ "$2" = 26.04 ]; } &&
        { [ "$3" = amd64 ] || [ "$3" = arm64 ]; }
}

valid_user() {
    [[ "$1" =~ ^[a-zA-Z][a-zA-Z0-9_-]{2,63}$ ]] || return 1
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
        admin|administrator|root|user|test|guest) return 1 ;;
    esac
}

valid_domain() {
    local label
    [ "${#1}" -le 253 ] && [[ "$1" == *.* ]] && [[ "$1" =~ ^[a-z0-9.-]+$ ]] || return 1
    # Public DNS names only; IPs, wildcards, URLs and Caddy syntax are refused.
    [[ "${1##*.}" =~ ^[a-z]{2,63}$ ]] || return 1
    case "$1" in *.localhost|*.local|*.internal|*.test|*.invalid|*.example) return 1 ;; esac
    local -a labels
    IFS=. read -ra labels <<< "$1"
    for label in "${labels[@]}"; do
        [ "${#label}" -le 63 ] && [[ "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
    done
}

# Reject every symlink component, including dangling links. The caller supplies
# fixed absolute paths; /var/run/docker.sock is separately checked as a socket.
plain_path() {
    local path="$1"
    while [ "$path" != / ]; do
        [ ! -L "$path" ] || return 1
        path="$(dirname "$path")"
    done
}

render_env() {
    printf '# Compose Panel installer v1 (ADR 0031)\n'
    printf 'COMPOSE_PANEL_ADMIN_USER=%s\n' "$admin_user"
    printf "COMPOSE_PANEL_ADMIN_PASSWORD_HASH='%s'\n" "$admin_hash"
    printf 'COMPOSE_PANEL_ALLOW_LOOPBACK=true\n'
    [ -z "$domain" ] || printf 'COMPOSE_PANEL_PROXY_ORIGINS=https://%s\n' "$domain"
    # The namespace is stripped from all application Compose subprocesses.
    printf "COMPOSE_PANEL_INSTALLER_PROXY_HASH='%s'\n" "$proxy_hash"
    printf 'COMPOSE_PANEL_CADDY_ENABLED=true\n'
    printf 'COMPOSE_PANEL_CADDY_SOCKET_PATH=/run/compose-panel/caddy-helper.sock\n'
}

render_caddy() {
    printf '# Compose Panel installer v1 (ADR 0031)\n'
    printf 'import /etc/caddy/compose-panel.d/*.caddy\n'
    if [ -n "$domain" ]; then
        cat <<EOF

$domain {
    basic_auth {
        $admin_user $proxy_hash
    }
    reverse_proxy 127.0.0.1:5081
}
EOF
    fi
}

# Publish a new file without overwriting a competing writer or a symlink.
publish_new() {
    local source="$1" destination="$2" mode="$3" candidate
    plain_path "$destination" || return 1
    [ ! -e "$destination" ] || return 1
    candidate="$(mktemp "$(dirname "$destination")/.compose-panel-install.XXXXXX")" || return 1
    if ! install -m "$mode" "$source" "$candidate" || ! ln "$candidate" "$destination"; then
        rm -f "$candidate"
        return 1
    fi
    rm -f "$candidate"
}

# publish_new, or accept a destination already byte-identical to the source:
# an interrupted earlier run may have published it. Anything else is refused.
publish_same() {
    if [ -e "$2" ] || [ -L "$2" ]; then
        plain_path "$2" && [ -f "$2" ] && cmp -s "$1" "$2" || return 1
        chown root:root "$2" && chmod "$3" "$2"
        return $?
    fi
    publish_new "$@"
}

# An APT repository can be (re)configured when every source mentioning it is
# one of the given installer paths, each absent or a plain file. Their content
# is compared after download by publish_same, so a foreign file is never adopted.
apt_repo_resumable() {
    local apt="$1" pattern="$2" path matches status=0
    local -a inputs=()
    shift 2
    for path in "$@"; do
        plain_path "$path" && { [ ! -e "$path" ] || [ -f "$path" ]; } || return 1
    done
    for path in "$apt/sources.list" "$apt/sources.list.d"; do
        [ ! -e "$path" ] || inputs+=("$path")
    done
    [ "${#inputs[@]}" -gt 0 ] || return 0
    # -R follows symlinked sources, as APT does. grep exits 1 without a match;
    # 2 (unreadable source, dangling link) refuses instead of hiding a match.
    matches="$(grep -RlE "$pattern" "${inputs[@]}" 2>/dev/null)" || status=$?
    [ "$status" -le 1 ] || return 1
    # A here-string, not a pipe: grep -q could otherwise SIGPIPE the writer.
    status=0
    grep -qvxF -e '' -f <(printf '%s\n' "$@") <<< "$matches" || status=$?
    [ "$status" -eq 1 ]
}

render_periodic() {
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nUnattended-Upgrade::Automatic-Reboot "false";\n'
}

configure_update_timers() {
    if plain_path "$UPDATE_POLICY" && [ -f "$UPDATE_POLICY" ] && cmp -s "$UPDATE_POLICY" <(render_periodic); then
        enable_now apt-daily.timer apt-daily-upgrade.timer
    elif ! timeout 20 systemctl is-enabled --quiet apt-daily-upgrade.timer ||
        ! timeout 20 systemctl is-active --quiet apt-daily-upgrade.timer; then
        printf '  WARN  The existing upgrade timer is disabled or inactive; review the administrator-managed update policy.\n'
    fi
}

caddy_version_supported() {
    [[ "$1" =~ ^v?([0-9]+)\.([0-9]+)\.[0-9]+([[:space:]]|$) ]] || return 1
    (( 10#${BASH_REMATCH[1]} > 2 || (10#${BASH_REMATCH[1]} == 2 && 10#${BASH_REMATCH[2]} >= 8) ))
}

# Root sources and runs files from the checkout, so only root or the sudo user
# may change them. A private user group (Ubuntu's umask 002) counts as that
# user. Ancestors may be sticky world-writable directories such as /tmp.
trusted_path() {
    local path="$1" ancestor="$2" uid gid mode
    read -r uid gid mode < <(stat -c '%u %g %a' "$path") || return 1
    [ "$uid" = 0 ] || [ "$uid" = "${SUDO_UID:-0}" ] || return 1
    if (( 8#$mode & 8#002 )); then
        [ "$ancestor" = 1 ] && [ -d "$path" ] && (( 8#$mode & 8#1000 )) || return 1
    fi
    if (( 8#$mode & 8#020 )); then
        [ "$gid" = 0 ] || [ "$gid" = "${SUDO_GID:-0}" ] || return 1
        [ -z "$(getent group "$gid" | cut -d: -f4)" ] &&
            [ "$(getent passwd | awk -F: -v g="$gid" '$4 == g' | wc -l)" -le 1 ] || return 1
    fi
}

trusted_checkout() {
    local repo="$1" path
    path="$(dirname "$repo")"
    while :; do
        trusted_path "$path" 1 || return 1
        [ "$path" != / ] || break
        path="$(dirname "$path")"
    done
    for path in "$repo" "$repo/scripts" "$repo/deploy" "$repo/deploy/caddy" \
        "$repo/scripts/install.sh" "$repo/scripts/setup-caddy.sh" "$repo/deploy/caddy/with-caddy-lock.sh" \
        "$repo/deploy/caddy/caddy-helper.socket" "$repo/deploy/caddy/caddy-helper@.service" \
        "$repo/deploy/compose.prod.yaml"; do
        [ -e "$path" ] && [ ! -L "$path" ] && trusted_path "$path" 0 || return 1
    done
}

# No logs or resolved Compose config: both can contain secrets.
wait_panel() {
    local i
    for ((i = 0; i < 60; i++)); do
        if [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' compose-panel 2>/dev/null)" = healthy ] &&
            curl --noproxy '*' -fsS --max-time 3 http://127.0.0.1:5081/health/live >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    return 1
}

hash_admin_password() {
    # Password bytes travel only through stdin, not Docker Config.Env or argv.
    timeout --kill-after=5 120 docker run --rm -i --network none --entrypoint bun "$IMAGE" -e \
        'const p = await Bun.stdin.text(); if (p.length < 12 || p.length > 1024) process.exit(1); console.log(await Bun.password.hash(p, {algorithm: "argon2id", memoryCost: 65536, timeCost: 3}));'
}

# Same stdin-only contract. Caddy reads one line: older releases fail on EOF
# without a newline, and Caddy strips that line ending from the password.
hash_proxy_password() {
    printf '%s\n' "$proxy_password" | timeout --kill-after=5 60 caddy hash-password
}

# atomic_host_file keeps the candidate's owner and mode. The Caddyfile holds
# the Basic Auth hash: readable by the caddy group only, whatever the umask.
write_caddy_candidate() {
    render_caddy > "$1"
    chown root:caddy "$1"
    chmod 0640 "$1"
}

# A rerun keeps the installer's own Caddyfile, but an earlier version may have
# left it world-readable: only permissions change, so no reload is needed.
secure_owned_caddyfile() {
    [ -f "$CADDYFILE" ] && [ ! -L "$CADDYFILE" ] || return 1
    [ "$(stat -c '%U:%G %a' "$CADDYFILE")" != "root:caddy 640" ] || return 0
    chown root:caddy "$CADDYFILE" && chmod 0640 "$CADDYFILE" &&
        printf '  ok    %s restricted to root:caddy 0640\n' "$CADDYFILE"
}

# Restrict only backups matching the owned configuration. Other backups may be
# administrator-managed: report unsafe permissions without adopting their bytes.
secure_caddy_backups() {
    local backup mode status
    for backup in "$CADDYFILE".bak-setup.*; do
        [ -e "$backup" ] || [ -L "$backup" ] || continue
        if ! plain_path "$backup" || [ ! -f "$backup" ]; then
            printf '  WARN  Review non-regular Caddy backup: %s\n' "$backup"
        elif cmp -s "$CADDYFILE" "$backup"; then
            chown root:root "$backup" && chmod 0600 "$backup" || return 1
        else
            mode="$(stat -c '%a' "$backup")" || return 1
            if (( 8#$mode & 8#007 )); then
                status=0
                grep -E '[$]2[aby][$][0-9]{2}[$]' "$backup" >/dev/null || status=$?
                [ "$status" -le 1 ] || return 1
                if [ "$status" -eq 0 ]; then
                    printf '  WARN  Caddy backup readable by other users; review and restrict it locally: %s\n' "$backup"
                fi
            fi
        fi
    done
}

# The Caddyfile shipped by the caddy package, unmodified (dpkg conffile
# checksum). A failed earlier run can leave it behind; nothing else is adopted.
packaged_caddyfile() {
    local expected
    installed caddy && [ -f "$CADDYFILE" ] && [ ! -L "$CADDYFILE" ] || return 1
    expected="$(dpkg-query -W -f='${Conffiles}\n' caddy 2>/dev/null |
        awk -v file="$CADDYFILE" '$1 == file && NF == 2 { print $2 }')"
    [[ "$expected" =~ ^[0-9a-f]{32}$ ]] && [ "$(md5sum < "$CADDYFILE" | cut -d' ' -f1)" = "$expected" ]
}

# A rerun keeps the existing container, hence its image and settings. It only
# starts it when an earlier run (an expired `up --wait`) or an administrator
# left it stopped; recreating an unhealthy container identically would not help.
start_existing_panel() {
    [ "$(docker inspect -f '{{.State.Running}}' compose-panel 2>/dev/null)" != true ] || return 0
    printf '  step  Starting the existing panel container (same image and settings).\n'
    timeout 60 docker start compose-panel >/dev/null
}

replace_caddy() {
    local result=0
    acquire_caddy_lock || return $?
    caddy_apply_candidate "$1" || result=$?
    # Keep the lock for the EXIT trap if rollback needs another attempt.
    [ -n "${caddy_pending_backup:-}" ] || release_caddy_lock || result=2
    return "$result"
}

check_installer_host() {
    [ "$(uname -s)" = Linux ] && [ "$(id -u)" -eq 0 ] || installer_die "Run as root on Ubuntu Server."
    # shellcheck disable=SC1091
    . "$1"
    arch="$(dpkg --print-architecture)"
    supported_host "$ID" "$VERSION_ID" "$arch" || installer_die "Supported: Ubuntu 24.04 or 26.04, amd64 or arm64."
    case "$VERSION_ID:$VERSION_CODENAME" in
        24.04:noble|26.04:resolute) ;;
        *) installer_die "Unexpected Ubuntu release codename." ;;
    esac
    [ -d "$2" ] || installer_die "A booted systemd host is required."
    printf 'Compose Panel installer — Ubuntu %s · %s\n\nChecking this server...\n' "$VERSION_ID" "$arch"
}

check_deployment_paths() {
    local host="$1" path
    for path in "$REPO/deploy" "$COMPOSE_FILE" "$ENV_FILE" "$host/opt/stacks" "$host/run/compose-panel" \
        "$host/etc/caddy" "$host/etc/caddy/Caddyfile" "$host/etc/caddy/compose-panel.d" \
        "$host/etc/apt/keyrings" "$host/etc/apt/sources.list.d" "$host/usr/share/keyrings" \
        "$host/usr/local/bin/compose-panel-caddy-helper" "$host/etc/systemd/system/caddy-helper.socket" \
        "$host/etc/systemd/system/caddy-helper@.service" "$LOG"; do
        plain_path "$path" || installer_die "Symbolic link refused: $path"
    done
    [ -f "$COMPOSE_FILE" ] || installer_die "Missing production Compose file."
    [ ! -e "$REPO/deploy/.env" ] && [ ! -L "$REPO/deploy/.env" ] || installer_die "Remove implicit deploy/.env before installation."
    for path in "$host/opt/stacks" "$host/run/compose-panel" "$host/etc/caddy/compose-panel.d"; do
        [ ! -e "$path" ] || [ -d "$path" ] || installer_die "Not a directory: $path"
    done
    [ ! -e "$LOG" ] || [ -f "$LOG" ] || installer_die "Not a regular file: $LOG"
}

check_existing_env() {
    local origin
    admin_user="" admin_hash="" domain="" proxy_hash="" password="" proxy_password="" repeat=""
    if [ -e "$ENV_FILE" ]; then
        [ -f "$ENV_FILE" ] && [ "$(stat -c '%u %a' "$ENV_FILE")" = '0 600' ] ||
            installer_die "Existing environment file must be regular, root-owned and mode 0600."
        admin_user="$(env_value "$ENV_FILE" COMPOSE_PANEL_ADMIN_USER)"
        admin_hash="$(env_value "$ENV_FILE" COMPOSE_PANEL_ADMIN_PASSWORD_HASH)"
        origin="$(env_value "$ENV_FILE" COMPOSE_PANEL_PROXY_ORIGINS)"
        domain="${origin#https://}"
        proxy_hash="$(env_value "$ENV_FILE" COMPOSE_PANEL_INSTALLER_PROXY_HASH)"
        valid_user "$admin_user" && [[ "$admin_hash" =~ ^\$argon2id\$[a-zA-Z0-9/+=,\$]+$ ]] ||
            installer_die "Existing credentials are not an installer configuration."
        if [ -n "$domain" ]; then
            [ "$origin" = "https://$domain" ] && valid_domain "$domain" &&
                [[ "$proxy_hash" =~ ^\$2[aby]\$[0-9]{2}\$[a-zA-Z0-9./]{53}$ ]] ||
                installer_die "Existing proxy settings are incompatible."
        else
            [ -z "$proxy_hash" ] || installer_die "Unexpected proxy hash in private mode."
        fi
        cmp -s "$ENV_FILE" <(render_env) || installer_die "Existing settings differ from the installer layout; use manual deployment."
        printf '  skip  Existing credentials and access settings will be preserved.\n'
    fi
}

check_docker_state() {
    local host="$1" containers named package
    # /snap/bin is outside PATH: a snap Docker would otherwise go unnoticed.
    if [ -e "$host/snap/bin/docker" ] || { command -v snap >/dev/null && timeout 20 snap list docker >/dev/null 2>&1; }; then
        installer_die "Docker is installed as a snap; only Docker CE from Docker's APT repository is supported."
    fi
    have_docker=0 have_panel=0 have_caddy=0 caddy_owned=0
    if command -v docker >/dev/null; then
        installed docker-ce && installed docker-compose-plugin || installer_die "Existing Docker is not Docker CE + Compose plugin; no packages were replaced."
        timeout 20 docker info >/dev/null 2>&1 || installer_die "Local Docker is unavailable; no service will be restarted."
        timeout 20 docker compose version >/dev/null 2>&1 || installer_die "Docker Compose plugin is unavailable."
        [ -S "$host/var/run/docker.sock" ] || installer_die "Local Docker socket is missing."
        have_docker=1
        systemctl is-enabled --quiet docker ||
            printf '  WARN  The existing docker service is not enabled at boot; the panel will not return after a reboot.\n'
        containers="$(timeout 20 docker ps -a --filter label=com.docker.compose.project=compose-panel --format '{{.Names}}')" ||
            installer_die "Cannot inspect existing Compose projects."
        [ -z "$containers" ] || [ "$containers" = compose-panel ] || installer_die "Compose project compose-panel already has other containers."
        named="$(timeout 20 docker ps -a --filter 'name=^/compose-panel$' --format '{{.Names}}')" ||
            installer_die "Cannot inspect the panel container."
        [ -z "$containers" ] || [ "$named" = compose-panel ] ||
            installer_die "The panel changed during inspection; retry the checks."
        if [ -n "$named" ]; then
            [ "$named" = compose-panel ] || installer_die "Unexpected panel container identity."
            panel_identity_matches && [ -f "$ENV_FILE" ] || installer_die "Existing panel belongs to another deployment."
            [ "$(docker inspect -f '{{.Config.Image}}' compose-panel)" = "$IMAGE" ] ||
                installer_die "Existing panel uses another image."
            have_panel=1
        fi
    else
        for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc docker-ce; do
            installed "$package" && installer_die "Conflicting or incomplete package: $package; resolve manually."
        done
        # Do not rewrite an administrator's repository, including a differently named one.
        apt_repo_resumable "$host/etc/apt" 'download\.docker\.com' "$host/etc/apt/keyrings/docker.asc" "$host/etc/apt/sources.list.d/docker.sources" ||
            installer_die "Existing Docker repository without a working engine; complete it manually."
    fi
}

check_caddy_state() {
    local host="$1" routes
    if command -v caddy >/dev/null || [ -e "$CADDYFILE" ]; then
        getent group caddy >/dev/null || installer_die "The caddy group is missing; complete the Caddy package installation."
        caddy_version_supported "$(timeout 20 caddy version)" || installer_die "Caddy 2.8 or later is required; upgrade it manually."
        if [ -f "$ENV_FILE" ] && [ -f "$CADDYFILE" ] && cmp -s "$CADDYFILE" <(render_caddy); then
            caddy_owned=1
        elif packaged_caddyfile; then
            # Resume after a failure that preceded the installer's Caddyfile.
            if [ -d "$MANAGED_DIR" ]; then
                routes="$(find "$MANAGED_DIR" -mindepth 1 -maxdepth 1 ! -name .lock -print -quit)" ||
                    installer_die "Cannot inspect managed Caddy routes."
                [ -z "$routes" ] || installer_die "Existing application routes without an installer-owned Caddyfile; review them manually."
            fi
            printf '  skip  Packaged default Caddyfile found; it will be replaced (backup first).\n'
        else
            installer_die "Existing Caddy configuration is not owned by this installer; use manual deployment and setup-caddy.sh."
        fi
        systemctl is-active --quiet caddy &&
            systemctl show caddy -p ExecStart --value | grep -F -- "--config $CADDYFILE" >/dev/null ||
            installer_die "Existing Caddy must be active with /etc/caddy/Caddyfile."
        systemctl is-enabled --quiet caddy ||
            printf '  WARN  The existing caddy service is not enabled at boot; HTTPS and application domains will stop after a reboot.\n'
        have_caddy=1
    else
        installed caddy && installer_die "Incomplete Caddy installation; resolve manually."
        apt_repo_resumable "$host/etc/apt" 'cloudsmith.*caddy' \
            "$host/usr/share/keyrings/caddy-stable-archive-keyring.gpg" "$host/etc/apt/sources.list.d/caddy-stable.list" ||
            installer_die "Existing Caddy repository; complete it manually."
        if [ -d "$MANAGED_DIR" ]; then
            routes="$(find "$MANAGED_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ||
                installer_die "Cannot inspect managed Caddy routes."
            [ -z "$routes" ] || installer_die "Existing application routes without an installer-owned Caddyfile; review them manually."
        fi
    fi
}

check_ports() {
    local listeners
    command -v ss >/dev/null || installer_die "ss (package iproute2) is required for the port checks."
    if [ "$have_caddy" = 0 ]; then
        listeners="$(timeout 20 ss -H -ltn '( sport = :80 or sport = :443 or sport = :2019 )')" ||
            installer_die "Cannot inspect Caddy TCP ports."
        [ -z "$listeners" ] || installer_die "Caddy ports 80, 443 or 2019 are occupied."
        listeners="$(timeout 20 ss -H -lun 'sport = :443')" || installer_die "Cannot inspect Caddy UDP port."
        [ -z "$listeners" ] || installer_die "Caddy HTTP/3 port UDP 443 is occupied."
    fi
    if [ "$have_panel" = 0 ]; then
        listeners="$(timeout 20 ss -H -ltn 'sport = :5081')" || installer_die "Cannot inspect the panel port."
        [ -z "$listeners" ] || installer_die "Panel port 5081 is occupied."
    fi
}

check_helper_state() {
    local host="$1" unit path
    for unit in caddy-helper.socket caddy-helper@.service; do
        path="$host/etc/systemd/system/$unit"
        [ ! -e "$path" ] || cmp -s "$path" "$REPO/deploy/caddy/$unit" ||
            installer_die "Existing helper unit differs: $path"
    done
    plain_path "$host/etc/apt/apt.conf.d/52compose-panel-periodic" ||
        installer_die "Symbolic link at the security-update configuration."
    if ! installed unattended-upgrades && [ -e "$host/etc/apt/apt.conf.d/52compose-panel-periodic" ]; then
        installer_die "Existing installer update policy without unattended-upgrades; resolve manually."
    fi
    # Existing units were compared above. The binary is rebuilt by setup-caddy.sh,
    # so one left without its units by an interrupted run is simply replaced.
    if [ -e "$HELPER_BIN" ]; then
        [ -f "$HELPER_BIN" ] && [ -x "$HELPER_BIN" ] || installer_die "Existing helper path is not an executable file: $HELPER_BIN"
    fi
}

# The root parameter is used only for read-only inspection fixtures. The CLI
# always passes /; installation paths and the tool PATH are never configurable.
installer_preflight() {
    local host="${1%/}"
    local CADDYFILE="$host/etc/caddy/Caddyfile" MANAGED_DIR="$host/etc/caddy/compose-panel.d"
    local HELPER_BIN="$host/usr/local/bin/compose-panel-caddy-helper"
    check_deployment_paths "$host"
    check_existing_env
    check_docker_state "$host"
    check_caddy_state "$host"
    check_ports
    check_helper_state "$host"
}

show_install_plan() {
    # What this run will do on this host, before anything is asked or changed.
    plan() { printf '  %-9s %s\n' "$1" "$2"; }
    printf '\nPlan for this server:\n'
    if [ "$have_docker" = 1 ]; then
        plan Docker "Docker CE $(timeout 20 docker version -f '{{.Server.Version}}' 2>/dev/null) present: kept, not upgraded or restarted"
    else
        plan Docker "install Docker CE and Compose from Docker's APT repository"
    fi
    if [ "$have_caddy" = 0 ]; then
        plan Caddy "install Caddy from its APT repository, as a systemd service"
    elif [ "$caddy_owned" = 1 ]; then
        plan Caddy "$(caddy version 2>/dev/null | cut -d' ' -f1) present, configured by this installer: kept"
    else
        plan Caddy "$(caddy version 2>/dev/null | cut -d' ' -f1) present: replace its default Caddyfile (backup first)"
    fi
    if installed unattended-upgrades; then
        plan Updates "unattended-upgrades present: policy kept"
    else
        plan Updates "install unattended-upgrades: daily security updates, no automatic reboot"
    fi
    if [ "$have_panel" = 1 ]; then
        plan Panel "existing container kept, same image; started if stopped"
    else
        plan Panel "pull $IMAGE and run it on 127.0.0.1:5081 only"
    fi
    plan Helper "build the Caddy helper from the panel image, install its systemd socket"
    if [ -f "$ENV_FILE" ]; then
        plan Access "existing settings kept: SSH tunnel${domain:+ and https://$domain}"
    else
        plan Access "you choose next: SSH tunnel only (default) or HTTPS on a domain"
    fi
    printf '\n'
    printf '  note  SSH and firewall rules stay unchanged. Keep your SSH port reachable (usually 22).\n'
    printf '  note  HTTPS needs DNS pointing here and inbound TCP 80/443 at the VPS and provider firewall.\n'
    printf '  note  Docker-published application ports can bypass UFW rules; 5081 is never published.\n'
    if command -v ufw >/dev/null; then
        printf '  note  UFW: %s\n' "$(ufw status 2>/dev/null | head -n 1)"
    fi
}

load_installer_checkout() {
    REPO="$1"
    [[ "$REPO" =~ ^/[a-zA-Z0-9_./-]+$ ]] || installer_die "Checkout path must use letters, digits, /, _, - or . only."
    command -v getent >/dev/null || installer_die "getent (package libc-bin) is required for checkout ownership checks."
    trusted_checkout "$REPO" ||
        installer_die "The checkout or one of its parent directories can be changed by another user; it must belong to root or the sudo user, without group/other write access."
    COMPOSE_FILE="$REPO/deploy/compose.prod.yaml"
    ENV_FILE="$REPO/deploy/compose-panel.env"
    IMAGE=ghcr.io/lekoala/compose-panel:latest
    LOG=/var/log/compose-panel-install.log
    # Reuse the exact Compose identity and invocation boundary of the host helper.
    COMPOSE_PANEL_SETUP_LIB=1 source "$REPO/scripts/setup-caddy.sh"
    COMPOSE_PANEL_CADDY_LOCK_LIB=1 CADDY_MANAGED_DIR="$MANAGED_DIR" source "$REPO/deploy/caddy/with-caddy-lock.sh"
}

installer_prepare() {
    # Fixed host tools and local daemon, regardless of the caller's Docker context.
    export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROFILES
    export DOCKER_HOST=unix:///var/run/docker.sock
    export COMPOSE_DISABLE_ENV_FILE=true
    check_installer_host /etc/os-release /run/systemd/system
    load_installer_checkout "$(cd "$(dirname "$0")/.." && pwd -P)"
}

installer_apply() {
    if [ "$ASSUME_YES" != 1 ]; then
        [ -t 0 ] || installer_die "No terminal for confirmation; use --yes."
        read -rp $'\nApply this plan? Type \'yes\': ' answer || installer_die "No answer; nothing changed."
        [ "$answer" = yes ] || installer_die "Not confirmed; nothing changed."
    fi

    # Invalid input is asked again; only a closed terminal stops the installer.
    ask() { read -rp "$1" "$2" || installer_die "Input closed; nothing changed."; }
    ask_secret() {
        read -rsp "$1" "$2" || { printf '\n'; installer_die "Input closed; nothing changed."; }
        printf '\n'
    }
    retry() { printf '        %s\n' "$1"; }

    if [ ! -f "$ENV_FILE" ]; then
        [ -t 0 ] || installer_die "First installation needs a terminal for credentials (also with --yes)."
        printf '\nAdministrator account\n'
        while :; do
            ask '  Username (3-64 letters, digits, _ or -, starting with a letter): ' admin_user
            valid_user "$admin_user" && break
            retry "Not accepted. Common names such as admin or root are refused too."
        done
        while :; do
            ask_secret '  Panel password (12-1024 characters): ' password
            ask_secret '  Repeat it: ' repeat
            if [ "$password" != "$repeat" ]; then
                retry "The passwords differ."
            elif [ "${#password}" -lt 12 ] || [ "${#password}" -gt 1024 ]; then
                retry "Use 12 to 1024 characters."
            else
                break
            fi
        done
        unset repeat
        printf '\nAccess\n'
        while :; do
            ask '  Panel domain, e.g. panel.example.org (empty = SSH tunnel only): ' domain
            [ -n "$domain" ] && ! valid_domain "$domain" || break
            retry "Enter a lowercase public DNS name, without https:// or a path."
        done
        if [ -n "$domain" ]; then
            printf '  HTTPS adds a browser password prompt before the panel login. Use a different password.\n'
            while :; do
                ask_secret '  HTTPS password (12-72 characters): ' proxy_password
                ask_secret '  Repeat it: ' repeat
                # bcrypt truncates after 72 bytes, not characters.
                if [ "$proxy_password" != "$repeat" ]; then
                    retry "The passwords differ."
                elif [ "$proxy_password" = "$password" ]; then
                    retry "Choose a password different from the panel password."
                elif [ "${#proxy_password}" -lt 12 ] || [ "$(LC_ALL=C; printf '%s' "${#proxy_password}")" -gt 72 ]; then
                    retry "Use 12 to 72 characters (bytes)."
                else
                    break
                fi
            done
            unset repeat
        fi
    fi
    if [ -n "$domain" ] && ! getent ahosts "$domain" >/dev/null; then
        printf '  WARN  %s does not resolve yet; HTTPS may stay pending until DNS points here.\n' "$domain"
    fi

    umask 077
    # Serialize installers without writing anything in --check mode.
    exec 9>/run/compose-panel-install.lock
    flock -n 9 || installer_die "Another installer is running."
    work="$(mktemp -d)"
    cleanup() {
        local result=$?
        unset password proxy_password
        caddy_rollback || result=2
        release_caddy_lock || result=2
        rm -rf "$work"
        if [ "$result" -ne 0 ] && [ "${https_unverified:-0}" != 1 ]; then
            printf '  FAIL  Installation incomplete. Completed package/file steps remain; stacks were not removed.\n' >&2
            printf '        Details: %s. Inspect the failed step before retrying; see docs/installation.md.\n' "$LOG" >&2
        fi
        exit "$result"
    }
    trap cleanup EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    # One run per log (root-only, umask 077): tool output only, never passwords.
    : > "$LOG"
    printf 'Compose Panel installer, %s\n' "$(date -Is)" >> "$LOG"
    # Long tool output goes to the log; on failure, its end is shown. No terminal
    # on stdin: under timeout(1), a command touching the tty (apt) is stopped by
    # SIGTTOU and would hang until its timeout.
    logged() {
        local status=0
        "$@" < /dev/null >> "$LOG" 2>&1 || status=$?
        [ "$status" -ne 0 ] || return 0
        printf '  FAIL  "%s" exited with %s. Last lines of %s:\n' "$*" "$status" "$LOG" >&2
        tail -n 15 "$LOG" | sed 's/^/        /' >&2
        return "$status"
    }
    STEP=0
    step() { STEP=$((STEP + 1)); printf '\n[%d/7] %s\n' "$STEP" "$1"; }
    fetch() { curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 120 --retry 2 "$@"; }
    # --no-upgrade: install what is missing, never upgrade what is already there.
    apt_install() { logged env DEBIAN_FRONTEND=noninteractive timeout 900 apt-get -o DPkg::Lock::Timeout=60 install -y --no-upgrade "$@"; }
    apt_update() { logged timeout 300 apt-get update; }
    enable_now() { logged timeout --kill-after=5 120 systemctl enable --now "$@"; }

    step "Base packages"
    apt_update
    apt_install ca-certificates curl gnupg
    printf '  ok    ca-certificates, curl, gnupg\n'

    step "Docker"
    if [ "$have_docker" = 0 ]; then
        install -d -m 0755 /etc/apt/keyrings
        fetch https://download.docker.com/linux/ubuntu/gpg -o "$work/docker.asc"
        cat > "$work/docker.sources" <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $VERSION_CODENAME
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
        publish_same "$work/docker.asc" /etc/apt/keyrings/docker.asc 0644 ||
            installer_die "Docker repository key differs from an existing file; resolve manually."
        publish_same "$work/docker.sources" /etc/apt/sources.list.d/docker.sources 0644 ||
            installer_die "Docker repository source differs from an existing file; resolve manually."
        printf '  ...   Installing Docker CE and Compose (usually a few minutes)\n'
        apt_update
        apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        enable_now docker
        printf '  ok    Docker CE %s installed and enabled at boot\n' "$(timeout 20 docker version -f '{{.Server.Version}}' 2>/dev/null)"
    else
        printf '  skip  Existing Docker kept, not upgraded or restarted\n'
    fi
    timeout 20 docker info >/dev/null 2>&1 || installer_die "Local Docker is unavailable."

    step "Caddy"
    if [ "$have_caddy" = 0 ]; then
        fetch https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$work/caddy.asc"
        # A private keyring: never create or use root's ~/.gnupg.
        install -d -m 0700 "$work/gnupg"
        gpg --batch --quiet --homedir "$work/gnupg" --dearmor -o "$work/caddy.gpg" "$work/caddy.asc"
        fetch https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o "$work/caddy.list"
        publish_same "$work/caddy.gpg" /usr/share/keyrings/caddy-stable-archive-keyring.gpg 0644 ||
            installer_die "Caddy repository key differs from an existing file; resolve manually."
        publish_same "$work/caddy.list" /etc/apt/sources.list.d/caddy-stable.list 0644 ||
            installer_die "Caddy repository source differs from an existing file; resolve manually."
        printf '  ...   Installing Caddy\n'
        apt_update
        apt_install caddy
        enable_now caddy
        printf '  ok    %s installed and enabled at boot\n' "$(caddy version 2>/dev/null | cut -d' ' -f1)"
    else
        printf '  skip  Existing Caddy kept\n'
    fi

    step "Security updates"
    UPDATE_POLICY=/etc/apt/apt.conf.d/52compose-panel-periodic
    if installed unattended-upgrades; then
        printf '  skip  Existing unattended-upgrades policy kept\n'
    else
        apt_install unattended-upgrades
        render_periodic > "$work/periodic"
        publish_new "$work/periodic" "$UPDATE_POLICY" 0644
        printf '  ok    Daily security updates enabled, no automatic reboot\n'
    fi
    configure_update_timers
    if ! apt-config dump | grep -E '^APT::Periodic::Unattended-Upgrade "1";$' >/dev/null; then
        printf '  WARN  Automatic security upgrades are disabled by the existing APT policy.\n'
    fi

    step "Panel"
    [ -d /opt/stacks ] || install -d -m 0755 /opt/stacks
    [ -d /run/compose-panel ] || install -d -m 0750 /run/compose-panel
    if [ "$have_panel" = 0 ]; then
        printf '  ...   Downloading %s\n' "$IMAGE"
        logged timeout 600 docker pull "$IMAGE"
    fi
    if [ ! -f "$ENV_FILE" ]; then
        admin_hash="$(printf '%s' "$password" | hash_admin_password)"
        unset password
        [[ "$admin_hash" =~ ^\$argon2id\$[a-zA-Z0-9/+=,\$]+$ ]] || installer_die "Password hasher returned an invalid result."
        if [ -n "$domain" ]; then
            proxy_hash="$(hash_proxy_password)"
            unset proxy_password
            [[ "$proxy_hash" =~ ^\$2[aby]\$[0-9]{2}\$[a-zA-Z0-9./]{53}$ ]] || installer_die "Caddy password hasher returned an invalid result."
        fi
        render_env > "$work/panel.env"
        publish_new "$work/panel.env" "$ENV_FILE" 0600
        printf '  ok    Settings written to %s (root only)\n' "$ENV_FILE"
    fi
    panel_compose config --quiet >/dev/null 2>&1 || installer_die "Production Compose configuration is invalid."
    if [ "$have_panel" = 0 ]; then
        logged panel_compose up -d --no-build --pull never --wait --wait-timeout 120 panel
    else
        start_existing_panel || installer_die "The existing panel container did not start; inspect docker logs compose-panel locally."
    fi
    wait_panel || installer_die "Panel is not healthy; inspect docker logs compose-panel locally."
    printf '  ok    Panel healthy on 127.0.0.1:5081\n'

    step "Caddy configuration and helper"
    if [ "$caddy_owned" = 0 ]; then
        install -d -o caddy -g caddy -m 0755 /etc/caddy/compose-panel.d
        write_caddy_candidate "$work/Caddyfile"
        logged replace_caddy "$work/Caddyfile" || installer_die "Caddy configuration failed; inspect its backup and service status."
        printf '  ok    Caddyfile written and reloaded (previous one backed up next to it)\n'
    else
        secure_owned_caddyfile || installer_die "Cannot restrict $CADDYFILE to root:caddy 0640."
    fi
    secure_caddy_backups || installer_die "Cannot restrict an installer Caddy backup."
    printf '  ...   Building the helper from the panel image\n'
    logged timeout 600 bash "$REPO/scripts/setup-caddy.sh" --install --yes --production
    wait_panel || installer_die "Panel failed its final health check."
    printf '  ok    Helper installed and answering from inside the panel\n'

    step "Access check"
    printf '  ok    SSH tunnel ready\n'
    https_line=""
    if [ -n "$domain" ]; then
        printf '  ...   Checking https://%s (up to 1 minute while the certificate is issued)\n' "$domain"
        for ((attempt = 0; attempt < 12; attempt++)); do
            # Validate public TLS/DNS and the local TLS listener separately. No -k.
            public="$(curl --noproxy '*' -sS --max-time 5 -o /dev/null -w '%{http_code}' "https://$domain/login" 2>/dev/null || true)"
            local_status="$(curl --noproxy '*' -sS --max-time 5 --resolve "$domain:443:127.0.0.1" -o /dev/null -w '%{http_code}' "https://$domain/login" 2>/dev/null || true)"
            if [ "$public" = 401 ] && [ "$local_status" = 401 ]; then break; fi
            sleep 5
        done
        if [ "$public" = 401 ] && [ "$local_status" = 401 ]; then
            printf '  ok    HTTPS certificate valid and Basic Auth answering\n'
            https_line="https://$domain (browser prompt: user $admin_user and the HTTPS password, then the panel login)"
        else
            printf '  WARN  HTTPS is not verified yet. Check DNS A/AAAA records, inbound TCP 80/443 and: journalctl -u caddy\n'
            printf '  note  Some provider images (Oracle Cloud, for example) block 80/443 with iptables rules outside UFW.\n'
            https_unverified=1
        fi
    fi

    printf '\nCompose Panel is installed.\n\n'
    printf '  %-9s ssh -L5081:127.0.0.1:5081 %s@<server address>, then open http://127.0.0.1:5081\n' "SSH" "${SUDO_USER:-you}"
    [ -z "$https_line" ] || printf '  %-9s %s\n' "HTTPS" "$https_line"
    [ -z "$domain" ] || [ -n "$https_line" ] || printf '  %-9s https://%s once DNS and ports are fixed; rerun this installer to verify\n' "HTTPS" "$domain"
    printf '  %-9s %s (do not edit by hand)\n' "Settings" "$ENV_FILE"
    printf '  %-9s %s\n' "Log" "$LOG"
    printf '  %-9s sudo bash scripts/doctor.sh --production\n' "Check"
    printf '  %-9s About > Update in the panel, then: sudo bash scripts/setup-caddy.sh --install --production\n' "Update"
    [ "${https_unverified:-0}" != 1 ] || exit 2
}

installer_main() {
    MODE=install
    ASSUME_YES=0
    for arg in "$@"; do
        case "$arg" in
            --check) MODE=check ;;
            --install) MODE=install ;;
            --yes) ASSUME_YES=1 ;;
            -h|--help) sed -n '2,4p' "$0" | sed 's/^# //'; exit 0 ;;
            *) installer_die "Unknown option: $arg" ;;
        esac
    done

    # Always the real host for CLI execution, independent of inherited variables.
    # Library fixtures replace installer_prepare and inspect a temporary tree.
    local inspection_root=/
    installer_prepare
    installer_preflight "$inspection_root"
    show_install_plan
    if [ "$MODE" = check ]; then
        printf '\n  ok    Checks passed; nothing was changed. Credentials and DNS come during installation.\n'
        return 0
    fi
    installer_apply
}

if [ "${COMPOSE_PANEL_INSTALL_LIB:-}" = 1 ]; then
    return 0 2>/dev/null || exit 0
fi

installer_main "$@"
