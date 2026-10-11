#!/usr/bin/env bash
# End-to-end check of reverse proxy mode behind a real Caddy with TLS, on Linux:
#   bun run test:proxy:wsl          # from Windows, through WSL
#   bash scripts/proxy-e2e/run.sh   # on a Linux machine
#
# Runs the working tree with a fake `docker` (fake-docker: answers the panel's
# calls, never contacts a daemon) behind Caddy (Caddyfile: internal CA, port
# 8443, two origins), then checks sign-in, Secure cookies, Origin/Host refusal,
# forged X-Forwarded-For, live SSE for actions and logs, UTF-8, that signing out
# closes open streams, and that the loopback (SSH-tunnel) path coexists with the
# proxy origins without mixing Origins or cookie attributes. Everything lives
# under $W; nothing is installed.
# Needs Bun (~/.bun) and curl; downloads a pinned Caddy release on first run.
set -u
SRC="$(pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
W="${COMPOSE_PANEL_PROXY_E2E_DIR:-/tmp/compose-panel-proxy-e2e}"
BUN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
CADDY_VERSION=2.8.4
O=https://panel.localhost:8443
O2=https://alt.localhost:8443
C=(curl -sk --resolve panel.localhost:8443:127.0.0.1 --resolve alt.localhost:8443:127.0.0.1)
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
ko() { echo "FAIL  $1"; fail=$((fail+1)); }
check() { if eval "$2"; then ok "$1"; else ko "$1"; fi; }

mkdir -p "$W"
if [ ! -x "$W/caddy" ]; then
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" | tar -xz -C "$W" caddy
fi
rm -rf "$W/app" "$W/stacks" "$W/audit" "$W"/jar* "$W"/ljar* "$W"/xjar* "$W"/*.log "$W"/*.txt "$W"/*.html "$W"/*.end "$W"/h1 "$W"/h2; mkdir -p "$W/stacks/demo" "$W/app"
printf 'services:\n  app:\n    image: nginx:alpine\n' > "$W/stacks/demo/compose.yaml"
cp "$HERE/fake-docker" "$W/fake-docker"; chmod +x "$W/fake-docker"; sed -i 's/\r$//' "$W/fake-docker"
rsync -a --delete --exclude node_modules --exclude .git --exclude private "$SRC/" "$W/app/"
cd "$W/app" && "$BUN" install --frozen-lockfile >/dev/null
HASH=$(COMPOSE_PANEL_PASSWORD=proxy-test-pw "$BUN" src/scripts/hash-password.ts | tail -1)

PROXY_E2E_STACK="$W/stacks/demo" STACKS_DIR="$W/stacks" COMPOSE_PANEL_ADMIN_USER=operator COMPOSE_PANEL_ADMIN_PASSWORD_HASH="$HASH" \
  COMPOSE_PANEL_PROXY_ORIGINS="$O,$O2" COMPOSE_PANEL_ALLOW_LOOPBACK=true COMPOSE_PANEL_DOCKER_PATH="$W/fake-docker" COMPOSE_PANEL_AUDIT_DIR="$W/audit" \
  "$BUN" src/server.ts > "$W/panel.log" 2>&1 &
PANEL=$!
# Started directly (no subshell) so $! is Caddy itself and the trap stops it.
XDG_DATA_HOME="$W/caddy-data" "$W/caddy" run --config "$HERE/Caddyfile" --adapter caddyfile > "$W/caddy.log" 2>&1 &
CADDY=$!
trap 'kill $PANEL $CADDY 2>/dev/null; pkill -f "fake-docker" 2>/dev/null' EXIT
ready=0
for i in $(seq 1 120); do
  if [ "$("${C[@]}" -o /dev/null -w '%{http_code}' "$O/login")" = 200 ]; then ready=1; break; fi
  sleep 0.5
done
if [ $ready -ne 1 ]; then echo "Panel or Caddy did not become ready; see $W/panel.log and $W/caddy.log"; exit 1; fi

# 1. Sign-in through the proxy, Secure cookies.
"${C[@]}" -c "$W/jar" -o "$W/login.html" -D "$W/h1" "$O/login"
CSRF=$(grep -o 'name="csrf" value="[^"]*"' "$W/login.html" | head -1 | cut -d'"' -f4)
check "login page served over TLS with a Secure CSRF cookie" "grep -qi 'set-cookie: cp_csrf=.*Secure' $W/h1"
CODE=$("${C[@]}" -b "$W/jar" -c "$W/jar" -D "$W/h2" -o /dev/null -w '%{http_code}' -H "Origin: $O" \
  --data-urlencode "csrf=$CSRF" --data-urlencode user=operator --data-urlencode password=proxy-test-pw "$O/login")
check "sign-in succeeds (303)" "[ $CODE = 303 ]"
check "session cookie is Secure, HttpOnly" "grep -qi 'set-cookie: cp_session=.*Secure' $W/h2 && grep -qi 'set-cookie: cp_session=.*HttpOnly' $W/h2"
check "stack list reachable" "\"\${C[@]}\" -b $W/jar $O/ | grep -q 'demo'"
PAGE=$("${C[@]}" -b "$W/jar" "$O/stacks/demo"); SCSRF=$(echo "$PAGE" | grep -o 'name="csrf" value="[^"]*"' | head -1 | cut -d'"' -f4)

# 2. Origin and Host checks.
CODE=$("${C[@]}" -b "$W/jar" -o /dev/null -w '%{http_code}' -H "Origin: https://evil.example" \
  --data-urlencode "csrf=$SCSRF" --data-urlencode action=up "$O/stacks/demo/operations")
check "action from a foreign Origin is refused (403)" "[ $CODE = 403 ]"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' http://127.0.0.1:5081/login)
check "unexpected Host on the loopback port is refused (400)" "[ $CODE = 400 ]"

# 3. Forged X-Forwarded-For does not reach the audit log.
"${C[@]}" -c "$W/jar2" -o "$W/l2.html" "$O/login"; C2=$(grep -o 'name="csrf" value="[^"]*"' "$W/l2.html" | head -1 | cut -d'"' -f4)
CODE=$("${C[@]}" -b "$W/jar2" -o /dev/null -w '%{http_code}' -H "Origin: $O" -H "X-Forwarded-For: 6.6.6.6" \
  --data-urlencode "csrf=$C2" --data-urlencode user=operator --data-urlencode password=wrong "$O/login")
sleep 0.3
check "forged X-Forwarded-For is not the recorded actor" "[ $CODE = 401 ] && ! grep -q '6.6.6.6' $W/audit/*.log && grep -q '\"result\":\"failure\".*\"actor\":\"127.0.0.1\"' $W/audit/*.log"

# 4. Operation output streams live through Caddy (no buffering until the end).
CODE=$("${C[@]}" -b "$W/jar" -o /dev/null -w '%{http_code}' -H "Origin: $O" \
  --data-urlencode "csrf=$SCSRF" --data-urlencode action=up "$O/stacks/demo/operations")
check "action accepted (303)" "[ $CODE = 303 ]"
"${C[@]}" -N -b "$W/jar" -m 6 "$O/stacks/demo/operations/events" 2>/dev/null | while IFS= read -r line; do echo "$(date +%s.%N) $line"; done > "$W/op-sse.txt"
FIRST=$(grep -m1 'event: output' "$W/op-sse.txt" | cut -d' ' -f1); LAST=$(grep 'event: output' "$W/op-sse.txt" | tail -1 | cut -d' ' -f1)
check "operation output arrives incrementally (spread over >1.5 s)" "[ -n \"$FIRST\" ] && awk -v a=$FIRST -v b=$LAST 'BEGIN{exit !(b-a>1.5)}'"
check "operation reaches done" "grep -q 'event: done' $W/op-sse.txt"

# 5. Log follow streams live, UTF-8 intact.
"${C[@]}" -N -b "$W/jar" -m 4 "$O/stacks/demo/logs/events" 2>/dev/null | while IFS= read -r line; do echo "$(date +%s.%N) $line"; done > "$W/log-sse.txt"
N=$(grep -c 'event: chunk' "$W/log-sse.txt")
check "log lines arrive live ($N chunks in 4 s)" "[ $N -ge 2 ]"
check "UTF-8 survives the proxy" "grep -q 'log line [0-9]* é' $W/log-sse.txt"

# 6. Sign-out closes an open stream.
("${C[@]}" -N -b "$W/jar" -m 20 "$O/stacks/demo/logs/events" > "$W/log2.txt" 2>/dev/null; echo "$(date +%s)" > "$W/log2.end") &
sleep 2
LCSRF=$("${C[@]}" -b "$W/jar" "$O/" | grep -o 'name="csrf" value="[^"]*"' | head -1 | cut -d'"' -f4)
T0=$(date +%s)
"${C[@]}" -b "$W/jar" -o /dev/null -H "Origin: $O" --data-urlencode "csrf=$LCSRF" "$O/logout"
sleep 2
check "sign-out closes the open log stream" "grep -q 'event: chunk' $W/log2.txt && [ -f $W/log2.end ] && [ \$(cat $W/log2.end) -ge $T0 ] && [ \$(cat $W/log2.end) -le \$((T0+2)) ]"
CODE=$("${C[@]}" -b "$W/jar" -o /dev/null -w '%{http_code}' "$O/")
check "after sign-out the session is gone (302 to login)" "[ $CODE = 302 ]"

# 7. A second configured origin is accepted, with its own Secure session.
"${C[@]}" -c "$W/jar3" -o "$W/l3.html" "$O2/login"
C3=$(grep -o 'name="csrf" value="[^"]*"' "$W/l3.html" | head -1 | cut -d'"' -f4)
CODE=$("${C[@]}" -b "$W/jar3" -c "$W/jar3" -D "$W/h3" -o /dev/null -w '%{http_code}' -H "Origin: $O2" \
  --data-urlencode "csrf=$C3" --data-urlencode user=operator --data-urlencode password=proxy-test-pw "$O2/login")
check "second proxy origin signs in (303)" "[ $CODE = 303 ]"
check "second origin session cookie is Secure" "grep -qi 'set-cookie: cp_session=.*Secure' $W/h3"

# 8. The loopback (SSH-tunnel) path coexists with the proxy origins.
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5081/login)
check "loopback login page served alongside the proxy (200)" "[ $CODE = 200 ]"
curl -s -c "$W/ljar" -o "$W/llogin.html" http://127.0.0.1:5081/login
LCSRF=$(grep -o 'name="csrf" value="[^"]*"' "$W/llogin.html" | head -1 | cut -d'"' -f4)
CODE=$(curl -s -b "$W/ljar" -c "$W/ljar" -D "$W/lh" -o /dev/null -w '%{http_code}' -H "Origin: http://127.0.0.1:5081" \
  --data-urlencode "csrf=$LCSRF" --data-urlencode user=operator --data-urlencode password=proxy-test-pw http://127.0.0.1:5081/login)
check "loopback sign-in succeeds (303)" "[ $CODE = 303 ]"
check "loopback session cookie is not Secure" "grep -qi 'set-cookie: cp_session=' $W/lh && ! grep -qi 'set-cookie: cp_session=.*Secure' $W/lh"

# 9. A proxy Origin posted on the loopback host is refused (no cross-path mix).
curl -s -c "$W/xjar" -o "$W/xlogin.html" http://127.0.0.1:5081/login
XCSRF=$(grep -o 'name="csrf" value="[^"]*"' "$W/xlogin.html" | head -1 | cut -d'"' -f4)
curl -s -b "$W/xjar" -D "$W/xh" -o /dev/null -H "Origin: $O" \
  --data-urlencode "csrf=$XCSRF" --data-urlencode user=operator --data-urlencode password=proxy-test-pw http://127.0.0.1:5081/login
check "a proxy Origin on the loopback host is refused" "grep -qi 'location: /login?e=blocked' $W/xh"

echo "---- $pass passed, $fail failed"
echo "---- panel log:"; sed -n 1,8p "$W/panel.log"
[ $fail -eq 0 ]
