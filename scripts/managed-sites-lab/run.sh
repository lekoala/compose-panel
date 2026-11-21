#!/usr/bin/env bash
# Proof of the managed-site bind-mount contract (ADR 0042, ADR 0043), without
# the panel:
#   bun run test:managed-sites:wsl          # from Windows, through WSL
#   bash scripts/managed-sites-lab/run.sh   # Linux dev machine or disposable VM
#
# It runs on its own disposable Docker-in-Docker daemon (scripts/docker-lab/
# lib.sh), creates ONE Compose project (nginx gateway + PHP-FPM) inside it and
# removes exactly the daemon, the project and the private directories it
# created. A failed cleanup is reported and fails the run.
#
# What it proves:
#   - the folder name is not the Compose project identity;
#   - both services mount runtime/ read-only at the same host and container
#     path, and no mount masks current;
#   - a release is served through runtime/current while runtime/ (the parent) is
#     mounted, so a pointer switch is visible to the running containers;
#   - static files follow the switch immediately, while PHP (including the front
#     controller on /) keeps the previous release until the runtime service is
#     force-recreated, which changes its container ID and not the gateway's;
#   - a force-recreate serves the new release, and a rollback restores the old
#     one with the same probe and front-controller answer;
#   - the probe answers HTTP 200 with exactly 40 lowercase hex characters and
#     one newline; public/ only: private/, the release root and the probe
#     script name are not reachable.
#
# Needs Docker with the Compose plugin and a writable ~/.cache. The lab daemon
# pulls two public images (overridable) the first time it runs.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURES="$HERE/fixtures"

PORT="${MANAGED_SITES_LAB_PORT:-18431}"
PROJECT="cp-mslab-$$"
STACK="stack-dir-$$"
SHA_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

source "$HERE/../docker-lab/lib.sh"
LAB_NAME="cp-mslab-$$"
LAB_IMAGE="${MANAGED_SITES_LAB_DIND_IMAGE:-docker:29.9.0-dind}"
lab_start

SITE="$LAB_SHARED/$STACK"
BASE="http://127.0.0.1:$PORT"

export LAB_PROJECT="$PROJECT"
export LAB_SITE_ROOT="$SITE"
export LAB_PORT="$PORT"
export LAB_FIXTURES="$FIXTURES"
export LAB_WEB_IMAGE="${MANAGED_SITES_LAB_WEB_IMAGE:-nginx:alpine}"
export LAB_RUNTIME_IMAGE="${MANAGED_SITES_LAB_RUNTIME_IMAGE:-php:8.3-fpm-alpine}"

compose() {
    # Everything below runs on the lab daemon, through DOCKER_HOST.
    docker compose -p "$PROJECT" -f "$FIXTURES/compose.yaml" --project-directory "$SITE" "$@"
}

on_exit() {
    local status=$?
    if [ -d "${SITE:-}" ]; then
        if ! compose down -v --remove-orphans >/dev/null 2>&1; then
            echo "lab: could not remove the Compose project $PROJECT" >&2
            status=1
        fi
    fi
    if ! lab_cleanup; then
        status=1
    fi
    exit "$status"
}
trap on_exit EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

pass() {
    echo "PASS: $*"
}

expect_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" != "$actual" ]; then
        fail "$label: expected [$expected], got [$actual]"
    fi
    pass "$label"
}

# One bounded request from inside the lab daemon: the gateway publishes on the
# lab container's loopback, so the host cannot reach it directly and the real
# 127.0.0.1-only binding is preserved. Succeeds only on HTTP 2xx with exactly
# 40 lowercase hex characters and one newline (41 bytes).
probe_request() {
    rm -f "$LAB_DIR/probe.body" "$LAB_DIR/probe.expected"
    if ! lab_outer_docker exec "$LAB_CONTAINER_ID" \
        wget -q -O - "$BASE/.compose-panel/revision" > "$LAB_DIR/probe.body" 2>/dev/null; then
        return 1
    fi
    [ "$(wc -c < "$LAB_DIR/probe.body" | tr -d ' ')" = "41" ] || return 1
    local body
    body="$(cat "$LAB_DIR/probe.body")"
    [[ "$body" =~ ^[0-9a-f]{40}$ ]] || return 1
    printf '%s\n' "$body" > "$LAB_DIR/probe.expected"
    cmp -s "$LAB_DIR/probe.expected" "$LAB_DIR/probe.body" || return 1
    printf '%s' "$body"
}

fetch_path() {
    lab_outer_docker exec "$LAB_CONTAINER_ID" wget -q -O - "$BASE$1"
}

wait_for_revision() {
    local expected="$1" i body
    body=""
    for i in $(seq 1 160); do
        body="$(probe_request 2>/dev/null || true)"
        if [ "$body" = "$expected" ]; then
            return 0
        fi
        sleep 0.25
    done
    fail "revision $expected never served; last answer: [$body]"
}

wait_for_any_revision() {
    local i body
    for i in $(seq 1 160); do
        body="$(probe_request 2>/dev/null || true)"
        if [ -n "$body" ]; then
            printf '%s' "$body"
            return 0
        fi
        sleep 0.25
    done
    fail "gateway never answered"
}

assert_mounts() {
    local id="$1" label="$2" mounts entry src dst rw saw=0
    mounts="$(docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Destination}}|{{.RW}} {{end}}' "$id")"
    case "$mounts" in
        *"$SITE/site/private"* | *"$SITE/site/staging"*)
            fail "$label mounts private/ or staging/" ;;
    esac
    case "$mounts" in
        *"$SITE/site/runtime/current"*)
            fail "$label mounts at or below current" ;;
    esac
    for entry in $mounts; do
        IFS='|' read -r _ src dst rw <<< "$entry"
        if [ "$dst" = "$SITE/site/runtime" ]; then
            [ "$src" = "$SITE/site/runtime" ] || fail "$label runtime source is [$src]"
            [ "$rw" = "false" ] || fail "$label mounts the runtime writable"
            saw=1
        fi
    done
    [ "$saw" = "1" ] || fail "$label does not mount the runtime"
    pass "$label mounts runtime read-only at the same path, nothing masks current"
}

# --- layout ---------------------------------------------------------------

publish_release() {
    local sha="$1"
    local dir="$SITE/site/runtime/releases/$sha"
    mkdir -p "$dir/public" "$dir/.compose-panel" "$SITE/site/private/releases" "$SITE/site/shared" "$SITE/site/staging"
    cat > "$dir/public/index.php" <<PHP
<?php
header('Content-Type: text/plain; charset=utf-8');
echo '$sha', "\n";
PHP
    printf '%s\n' "$sha" > "$dir/public/static.txt"
    cat > "$dir/.compose-panel/revision.php" <<PHP
<?php
header('Content-Type: text/plain; charset=utf-8');
echo '$sha', "\n";
PHP
    printf '%s\n' "$sha" > "$dir/REVISION"
    printf '{"sha":"%s","status":"complete"}\n' "$sha" > "$SITE/site/private/releases/$sha.json"
}

switch_current() {
    local sha="$1"
    ln -sfn "releases/$sha" "$SITE/site/runtime/.current.tmp"
    mv -T "$SITE/site/runtime/.current.tmp" "$SITE/site/runtime/current"
}

# --- run ------------------------------------------------------------------

echo "managed-site lab: project=$PROJECT stack=$STACK port=$PORT"
echo "site root: $SITE"

mkdir -p "$SITE/site/runtime/releases" "$SITE/site/staging" "$SITE/site/shared" "$SITE/site/private/releases" "$SITE/generated"
publish_release "$SHA_A"
publish_release "$SHA_B"
sed -e "s#__SITE_ROOT__#$SITE#g" "$FIXTURES/nginx-site.conf" > "$SITE/generated/nginx-site.conf"
printf 'do-not-serve\n' > "$SITE/site/private/secret.txt"
printf 'release-root-marker\n' > "$SITE/site/runtime/releases/$SHA_A/REVISION"
printf '{"marker":"manifest-marker"}\n' > "$SITE/compose-panel-site.json"
switch_current "$SHA_A"
expect_eq "current is a relative symlink" "releases/$SHA_A" "$(readlink "$SITE/site/runtime/current")"

lab_seed_from_cache "$LAB_WEB_IMAGE" "$LAB_RUNTIME_IMAGE"
compose up -d --quiet-pull
wait_for_revision "$SHA_A"
pass "first release is served"
expect_eq "static asset of release A" "$SHA_A" "$(fetch_path /static.txt)"
expect_eq "front controller serves release A on /" "$SHA_A" "$(fetch_path /)"

ids="$(compose ps -q)"
expect_eq "both services are running" "2" "$(printf '%s\n' "$ids" | wc -l | tr -d ' ')"
for id in $ids; do
    expect_eq "container carries the declared project" "$PROJECT" \
        "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$id")"
done

web_id="$(compose ps -q web)"
php_id="$(compose ps -q php)"
expect_eq "gateway publishes one loopback port" "80/tcp -> 127.0.0.1:$PORT" "$(docker port "$web_id")"
expect_eq "runtime publishes nothing" "" "$(docker port "$php_id")"
assert_mounts "$web_id" "gateway"
assert_mounts "$php_id" "runtime"

for path in "/private/secret.txt" "/../private/secret.txt" "/REVISION" "/../compose-panel-site.json"; do
    body="$(fetch_path "$path" 2>/dev/null || true)"
    case "$body" in
        *"do-not-serve"* | *"release-root-marker"* | *"manifest-marker"*)
            fail "$path exposes a file outside public/" ;;
    esac
done
pass "files outside public/ are not exposed"
if lab_outer_docker exec "$LAB_CONTAINER_ID" wget -q --spider "$BASE/.compose-panel/revision.php" >/dev/null 2>&1; then
    fail "the probe script is reachable by its .php name"
fi
pass "the probe script is not reachable by its .php name"

compose stop web
if [ -n "$(compose ps --status running -q web)" ]; then
    fail "gateway still running after stop"
fi
if probe_request >/dev/null 2>&1; then
    fail "probe still answers with the gateway stopped"
fi
pass "a stopped gateway does not answer"

switch_current "$SHA_B"
compose start web
served="$(wait_for_any_revision)"
expect_eq "PHP keeps release A until the runtime is force-recreated" "$SHA_A" "$served"
expect_eq "the front controller still serves release A" "$SHA_A" "$(fetch_path /)"
expect_eq "a static asset already follows the switch" "$SHA_B" "$(fetch_path /static.txt)"

compose up -d --no-deps --force-recreate php
wait_for_revision "$SHA_B"
pass "a force-recreated runtime serves release B"
expect_eq "the front controller serves release B on /" "$SHA_B" "$(fetch_path /)"
php_id_b="$(compose ps -q php)"
web_id_b="$(compose ps -q web)"
if [ "$php_id_b" = "$php_id" ]; then
    fail "the runtime container was not recreated (same ID $php_id)"
fi
expect_eq "the gateway container was not recreated" "$web_id" "$web_id_b"
pass "the runtime container ID changed"

compose stop web
switch_current "$SHA_A"
compose up -d --no-deps --force-recreate php
compose start web
wait_for_revision "$SHA_A"
pass "a rollback serves release A again"
expect_eq "the front controller serves release A after the rollback" "$SHA_A" "$(fetch_path /)"
php_id_r="$(compose ps -q php)"
web_id_r="$(compose ps -q web)"
if [ "$php_id_r" = "$php_id_b" ]; then
    fail "the rollback did not recreate the runtime (same ID $php_id_b)"
fi
expect_eq "the gateway container survived the rollback restart" "$web_id" "$web_id_r"

for sha in "$SHA_A" "$SHA_B"; do
    [ -d "$SITE/site/runtime/releases/$sha" ] || fail "release $sha was removed"
done
pass "both releases are retained after the rollback"

echo
echo "managed-site lab OK"
