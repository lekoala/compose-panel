#!/usr/bin/env bash
# Day-two host operations for an installer deployment (ADR 0031).
# sudo bash scripts/host-ops.sh <command>
#
# The commands are explicit: there is no arbitrary command, path or Docker
# argument. Passwords are read from the terminal, hashed exactly as the
# installer does, and never written to a log or passed as a command argument.
# Each edit keeps a timestamped backup next to the file it replaces.
#
#   panel-password             change the panel administrator password
#   https-password <domain>    change the Basic Auth password of one HTTPS site
#   managed-sites on|off       toggle the managed-site pilot flag
set +x
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO/deploy/compose-panel.env"
COMPOSE_FILE="$REPO/deploy/compose.prod.yaml"
CADDYFILE=/etc/caddy/Caddyfile

die() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
ok() { printf '  ok    %s\n' "$*"; }

usage() {
    cat <<'TXT'
Usage: sudo bash scripts/host-ops.sh <command>

  panel-password             Change the panel administrator password.
  https-password <domain>    Change the Basic Auth password of one HTTPS site.
  managed-sites on|off       Toggle the managed-site pilot flag.

Passwords are prompted twice and never echoed. The panel is recreated only when
its settings change. The LibreDB administrator password is not an environment
value once seeded: change it in LibreDB under Admin > Accounts.
TXT
}

require_root() {
    [ "$(id -u)" = 0 ] || die "Run this script with sudo."
}

require_python() {
    command -v python3 >/dev/null 2>&1 || die "python3 is required for the in-place edits."
}

require_installer() {
    if [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
        die "No installer settings at $ENV_FILE."
    fi
    [ "$(stat -c '%u %a' "$ENV_FILE")" = "0 600" ] || die "$ENV_FILE must be a root-owned 0600 file."
}

env_value() {
    local line value
    line="$(grep -E "^$2=" "$1" | tail -n 1)" || return 1
    value="${line#*=}"
    value="${value#\'}"
    value="${value%\'}"
    printf '%s\n' "$value"
}

backup_file() {
    local stamp
    stamp="$(date +%Y%m%dT%H%M%S)"
    cp -a "$1" "$1.bak-ops-$stamp"
    ok "backup $1.bak-ops-$stamp"
}

# Replace or append one key. The rendered value follows the installer: a value
# containing "$" (Argon2id, bcrypt) is single-quoted, a plain value is not.
set_env_key() {
    NEW_KEY="$1" NEW_VALUE="$2" TARGET="$ENV_FILE" python3 - <<'PY'
import os, pathlib, stat, tempfile

path = pathlib.Path(os.environ["TARGET"])
key, value = os.environ["NEW_KEY"], os.environ["NEW_VALUE"]
rendered = f"{key}='{value}'" if "$" in value else f"{key}={value}"
lines = path.read_text().splitlines()
out, found = [], False
for line in lines:
    if line.startswith(key + "="):
        out.append(rendered)
        found = True
    else:
        out.append(line)
if not found:
    out.append(rendered)
metadata = path.stat()
fd, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.")
with os.fdopen(fd, "w") as handle:
    handle.write("\n".join(out) + "\n")
os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
os.chown(temporary, metadata.st_uid, metadata.st_gid)
os.replace(temporary, path)
PY
}

# Print the single Basic Auth user of a site block, or fail.
https_user() {
    DOMAIN="$1" TARGET="$CADDYFILE" python3 - <<'PY'
import os, pathlib, re

lines = pathlib.Path(os.environ["TARGET"]).read_text().splitlines()
domain = os.environ["DOMAIN"]
if domain + " {" not in lines:
    raise SystemExit(1)
start = lines.index(domain + " {")
end = next((i for i in range(start + 1, len(lines)) if lines[i] == "}"), None)
if end is None:
    raise SystemExit(1)
pattern = re.compile(r"^\s+([A-Za-z0-9._-]+)\s+\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}\s*$")
users = [m.group(1) for line in lines[start + 1 : end] if (m := pattern.match(line))]
if len(users) != 1:
    raise SystemExit(1)
print(users[0])
PY
}

# Replace the credential line inside one site block; every other byte is kept.
replace_https_hash() {
    DOMAIN="$1" BASIC_USER="$2" BASIC_HASH="$3" TARGET="$CADDYFILE" python3 - <<'PY'
import os, pathlib, re, stat, tempfile

path = pathlib.Path(os.environ["TARGET"])
domain = os.environ["DOMAIN"]
user = os.environ["BASIC_USER"]
new_hash = os.environ["BASIC_HASH"]
lines = path.read_text().splitlines()
start = lines.index(domain + " {")
end = next((i for i in range(start + 1, len(lines)) if lines[i] == "}"), None)
if end is None:
    raise SystemExit("unterminated site block")
pattern = re.compile(r"^(\s+)([A-Za-z0-9._-]+)(\s+)\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}\s*$")
for index in range(start + 1, end):
    match = pattern.match(lines[index])
    if match:
        lines[index] = f"{match.group(1)}{user}{match.group(3)}{new_hash}"
        break
else:
    raise SystemExit("no Basic Auth credential line in that block")
metadata = path.stat()
fd, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=".Caddyfile.")
with os.fdopen(fd, "w") as handle:
    handle.write("\n".join(lines) + "\n")
os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
os.chown(temporary, metadata.st_uid, metadata.st_gid)
os.replace(temporary, path)
PY
}

# Characters are counted for the minimum, bytes for the maximum (bcrypt stops
# at 72 bytes). The value is assigned through printf -v, never through argv.
read_secret() {
    local value repeat bytes minimum="$3" maximum="$4"
    while :; do
        read -rsp "$2" value || die "Input closed; nothing changed."
        printf '\n'
        bytes="$(LC_ALL=C; printf '%s' "$value" | wc -c)"
        if [ "${#value}" -lt "$minimum" ] || [ "$bytes" -gt "$maximum" ]; then
            printf '  Use %s characters or more, %s bytes at most.\n' "$minimum" "$maximum"
            continue
        fi
        read -rsp '  Repeat it: ' repeat || die "Input closed; nothing changed."
        printf '\n'
        [ "$value" = "$repeat" ] || {
            printf '  The passwords differ.\n'
            continue
        }
        printf -v "$1" '%s' "$value"
        return 0
    done
}

hash_panel_password() {
    local image
    image="$(docker inspect compose-panel --format '{{.Config.Image}}' 2>/dev/null)" ||
        die "The panel container is not running."
    printf '%s' "$1" | timeout --kill-after=5 120 docker run --rm -i --network none --entrypoint bun "$image" -e \
        'const p = await Bun.stdin.text(); if (p.length < 12 || p.length > 1024) process.exit(1); console.log(await Bun.password.hash(p, {algorithm: "argon2id", memoryCost: 65536, timeCost: 3}));'
}

recreate_panel() {
    timeout --kill-after=10 600 env -u COMPOSE_FILE -u COMPOSE_ENV_FILES -u COMPOSE_PROFILES COMPOSE_DISABLE_ENV_FILE=true \
        docker compose -p compose-panel --project-directory "$REPO/deploy" -f "$COMPOSE_FILE" \
        up -d --no-build --pull never --force-recreate --wait --wait-timeout 120 panel
    curl -fsS --max-time 10 http://127.0.0.1:5081/health/live >/dev/null ||
        die "The panel did not answer after the restart."
    ok "panel healthy on 127.0.0.1:5081"
}

panel_password() {
    local password hash user
    require_root
    require_installer
    require_python
    [ "$#" -eq 0 ] || die "panel-password takes no argument."
    user="$(env_value "$ENV_FILE" COMPOSE_PANEL_ADMIN_USER)" || die "COMPOSE_PANEL_ADMIN_USER is missing."
    printf 'Changing the panel password for %s.\n' "$user"
    read_secret password '  New panel password: ' 12 1024
    hash="$(hash_panel_password "$password")" || die "The password hasher failed."
    unset password
    [[ "$hash" =~ ^\$argon2id\$[a-zA-Z0-9/+=,\$]+$ ]] ||
        die "The password hasher returned an invalid result."
    backup_file "$ENV_FILE"
    set_env_key COMPOSE_PANEL_ADMIN_PASSWORD_HASH "$hash"
    ok "$ENV_FILE updated"
    recreate_panel
    printf '  done  sign in with the new password; every session ended.\n'
}

https_password() {
    local domain="${1:-}" password hash user panel_domain no_auth code netrc
    require_root
    require_installer
    require_python
    [ "$#" -eq 1 ] || die "Usage: host-ops.sh https-password <domain>."
    [[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
        die "Not a lowercase DNS name: $domain"
    if [ ! -f "$CADDYFILE" ] || [ -L "$CADDYFILE" ]; then
        die "No regular $CADDYFILE."
    fi
    user="$(https_user "$domain")" || die "No single Basic Auth user in the $domain block."
    printf 'Changing the HTTPS password for %s (user %s).\n' "$domain" "$user"
    read_secret password '  New HTTPS password: ' 12 72
    hash="$(printf '%s\n' "$password" | timeout --kill-after=5 60 caddy hash-password)" ||
        die "The Caddy password hasher failed."
    [[ "$hash" =~ ^\$2[aby]\$[0-9]{2}\$[a-zA-Z0-9./]{53}$ ]] ||
        die "Caddy returned an invalid hash."
    backup_file "$CADDYFILE"
    replace_https_hash "$domain" "$user" "$hash" || die "Could not update the $domain block."
    caddy validate --config "$CADDYFILE" >/dev/null 2>&1 ||
        die "Caddy refused the modified configuration; restore the backup above."
    systemctl reload caddy || die "Caddy reload failed."
    ok "Caddy reloaded"
    panel_domain="$(env_value "$ENV_FILE" COMPOSE_PANEL_PROXY_ORIGINS 2>/dev/null || true)"
    panel_domain="${panel_domain#https://}"
    if [ "$domain" = "$panel_domain" ]; then
        backup_file "$ENV_FILE"
        set_env_key COMPOSE_PANEL_INSTALLER_PROXY_HASH "$hash"
        ok "installer proxy hash updated"
    fi
    no_auth="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$domain/")" || true
    netrc="$(mktemp)"
    chmod 600 "$netrc"
    printf 'machine %s login %s password %s\n' "$domain" "$user" "$password" >"$netrc"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 --netrc-file "$netrc" "https://$domain/")" || true
    rm -f "$netrc"
    unset password
    case "$code" in
        2* | 3*) ;;
        *) die "The new password was refused (HTTP ${code:-no response}); restore the backup above." ;;
    esac
    [ "$no_auth" = 401 ] || printf '  note  without credentials: HTTP %s (expected 401)\n' "$no_auth"
    ok "https://$domain answers with the new password"
}

managed_sites() {
    local state="${1:-}" flag
    require_root
    require_installer
    require_python
    [ "$#" -eq 1 ] || die "Usage: host-ops.sh managed-sites on|off."
    case "$state" in
        on) flag=true ;;
        off) flag=false ;;
        *) die "Use on or off." ;;
    esac
    backup_file "$ENV_FILE"
    set_env_key COMPOSE_PANEL_MANAGED_SITES_ENABLED "$flag"
    ok "COMPOSE_PANEL_MANAGED_SITES_ENABLED=$flag"
    recreate_panel
    printf '  done  managed sites are %s.\n' "$state"
}

case "${1:-}" in
    panel-password)
        shift
        panel_password "$@"
        ;;
    https-password)
        shift
        https_password "$@"
        ;;
    managed-sites)
        shift
        managed_sites "$@"
        ;;
    -h | --help | help | "")
        usage
        ;;
    *)
        die "Unknown command: ${1}. Run with --help."
        ;;
esac
