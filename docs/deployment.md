# Deployment — single Linux host

One panel container, one Docker Engine, one administrator. The panel never
owns your stacks: Compose files on disk and Docker itself stay the sources of
truth, so removing the panel never stops your services.

## Prerequisites

- Linux host with Docker Engine + Compose v2 and the stacks directory
  (e.g. `/opt/stacks`) already managed by `docker compose`.
- Bun 1.4.3+ on the build machine (pinned in CI and the Dockerfile).
- An admin password hash generated **outside** the image:
  `COMPOSE_PANEL_PASSWORD='...' bun run hash-password`.
- A unique admin username (`COMPOSE_PANEL_ADMIN_USER`): common names
  (`admin`, `root`, …) are refused at startup unless `COMPOSE_PANEL_DEV=true`.

## Deploy

```sh
cp deploy/compose-panel.env.example deploy/compose-panel.env
# Fill in COMPOSE_PANEL_ADMIN_PASSWORD_HASH in deploy/compose-panel.env.
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml up -d
curl -fsS http://127.0.0.1:5081/health/live  # -> ok
```

Rules that must stay true:

- **Host path == container path** for stacks (`/opt/stacks:/opt/stacks` plus
  matching `STACKS_DIR`) and the socket. Otherwise `compose ls` ConfigFiles
  no longer match and stacks report `unknown`.
- **`stop_grace_period` (35s) must exceed `COMPOSE_PANEL_SHUTDOWN_GRACE_MS`**
  (default 30s) so `SIGTERM` drains running operations instead of killing them.
- The panel binds **127.0.0.1 only** (hard-coded). With host networking that
  is the host loopback. Remote access goes through an SSH tunnel
  (`ssh -L5081:127.0.0.1:5081 you@host`) or through Caddy on the same host
  (next section). Never add a `ports:` mapping: there is nothing to publish.
- Sessions live in memory: every panel restart logs the admin out. No session
  persistence is needed or provided.
- Mounting `/var/run/docker.sock` gives whoever can edit Compose files very
  high control over the host (see `docs/security.md`). Trusted admin only.
- Panel settings must stay in the `COMPOSE_PANEL_*` namespace. Compose
  subprocesses get the process environment with that namespace stripped
  ([ADR 0008](adr/0008-compose-subprocess-environment.md)), so panel secrets
  never reach a stack. Other variables (e.g. `COMPOSE_PROJECT_NAME`,
  `DOCKER_HOST`) pass through by design.

## Behind Caddy (HTTPS)

To use the panel from a browser without a tunnel, put Caddy in front of it on
the **same host** ([ADR 0010](adr/0010-reverse-proxy-mode.md)). The panel stays
bound to `127.0.0.1`, so Caddy must reach the host loopback: run it on the host
itself, or in a container with `network_mode: host`.

1. In `deploy/compose-panel.env`, set the public origin. This single setting
   turns on Secure cookies and reads the client address from Caddy's
   `X-Forwarded-For`:

   ```sh
   COMPOSE_PANEL_PUBLIC_ORIGIN=https://panel.example.com
   ```

   It must be `https`. Startup is refused if it is `http`, or if
   `COMPOSE_PANEL_COOKIE_SECURE=false` or `COMPOSE_PANEL_TRUST_PROXY=false` is
   also set: those combinations would leak the session or let one client slow
   down everyone's sign-in.

2. Add a site to Caddy. Caddy obtains the certificate, redirects HTTP to HTTPS
   and streams the live output without extra settings:

   ```caddyfile
   panel.example.com {
   	reverse_proxy 127.0.0.1:5081
   }
   ```

   With caddy-docker-proxy (labels), the Caddy container must use
   `network_mode: host` for `127.0.0.1` to mean the host. Then add to the
   panel service in `deploy/compose.yaml`:

   ```yaml
   labels:
     caddy: panel.example.com
     caddy.reverse_proxy: 127.0.0.1:5081
   ```

   A Caddy container on a bridge network cannot reach the panel. That is
   deliberate: the bind is not configurable.

3. Restart the panel and check that it says `Reverse proxy mode: public origin
   https://panel.example.com, Secure cookies on` at startup. Sign in through the
   public URL. In this mode, forms posted through the SSH tunnel are refused
   (wrong Origin): use one access path at a time.

**Add a second barrier.** The panel controls Docker, i.e. the host, and one
password protects it. In order of preference:

- keep it off the public internet: Tailscale or WireGuard, and a Caddy site
  bound to that interface;
- restrict sources in Caddy:

  ```caddyfile
  panel.example.com {
  	@outside not remote_ip 203.0.113.0/24
  	respond @outside 403
  	reverse_proxy 127.0.0.1:5081
  }
  ```

- or add Caddy `basic_auth` in front of the panel's own sign-in;
- and in every case, ban repeated failures at the host from the activity log
  (see [Host-level ban](#host-level-ban-fail2ban--crowdsec)).

Only Caddy is tested (`bun run test:proxy:wsl`, or
`bash scripts/proxy-e2e/run.sh` on Linux: a real Caddy with TLS in front of the
working tree, with a fake `docker` that never touches a daemon). Other proxies
need explicit SSE flushing and correct `X-Forwarded-For` handling, and are not
covered.

## Backups and rollback

Two layers, both plain files:

1. **Per-save backups** made by the panel itself under
   `<root>/.compose-panel/backups/<stack>/` (previous `compose.yaml`/`.env`
   before each write). To roll a stack back, copy the backup over the live
   file, then `docker compose up -d` from that directory.
2. **Host-level stacks backup** before upgrades or risky edits:
   `tar -czf /root/stacks-backup-$(date +%F).tar.gz -C /opt stacks`.
   Restore with `tar -xzf`, then re-read state in the panel.

Upgrade procedure: back up (layer 2), `docker compose -f deploy/compose.yaml
build && docker compose -f deploy/compose.yaml up -d`, run the smoke checks
below. Rollback: check out the previous tag/commit, rebuild, `up -d` again;
stack files are untouched by either direction.

Removal without impact: `docker compose -f deploy/compose.yaml down`
removes only the panel container. Running services, networks and volumes are
untouched — verify with `docker ps` afterwards. Stacks remain fully manageable
by the `docker compose` CLI.

## Activity log

The panel writes an append-only audit log of sign-ins, saves and operation
starts as NDJSON, one file per day under
`<root>/.compose-panel/audit/` (inside the already-mounted stacks directory, so
no new volume is needed). The most recent `COMPOSE_PANEL_AUDIT_RETAIN_FILES`
files (default 31) are kept. A read-only view is available at `/audit` once
signed in. The log never contains passwords, hashes or `.env` values.

Useful variables: `COMPOSE_PANEL_AUDIT_ENABLED` (default `true`),
`COMPOSE_PANEL_AUDIT_DIR` (default the stacks path above),
`COMPOSE_PANEL_AUDIT_ROTATION` (`day` or `month`),
`COMPOSE_PANEL_AUDIT_RETAIN_FILES`, `COMPOSE_PANEL_AUDIT_MAX_READ_LINES`.

The activity log, the start time of an action and container logs are all shown
in one display time zone. Set `COMPOSE_PANEL_TIMEZONE` to an IANA name (e.g.
`Europe/Brussels`) to fix it for every reader; leave it unset to use each
reader's browser zone. Timestamps are always stored and emitted in UTC: this
only changes presentation, and an invalid zone is refused at startup.

Every failed login is a line like:

```json
{"ts":"2026-10-10T09:00:00.000Z","event":"login","result":"failure","actor":"203.0.113.7","username":"admin account","detail":"over limit, delayed"}
```

### Host-level ban (fail2ban / CrowdSec)

The panel throttles logins itself (a bounded delay, never a lockout), so a real
source ban belongs at the host, on the SSH daemon and on this audit file. This
is only meaningful behind Caddy (see [Behind Caddy](#behind-caddy-https)):
then `actor` is the client address, taken from the last `X-Forwarded-For`
entry, the one Caddy added. Through an SSH tunnel `actor` is `direct`. A
minimal fail2ban jail (NDJSON parsed with a regex filter), banning the HTTPS
ports Caddy listens on:

```ini
# /etc/fail2ban/filter.d/compose-panel.conf
[Definition]
failregex = "result":"failure".*"actor":"<HOST>"
```

```ini
# /etc/fail2ban/jail.d/compose-panel.conf
[compose-panel]
enabled  = true
port     = http,https
filter   = compose-panel
logpath  = /opt/stacks/.compose-panel/audit/*.log
maxretry = 10
findtime = 600
bantime  = 3600
```

Forwarded addresses are trusted only in proxy mode (`COMPOSE_PANEL_PUBLIC_ORIGIN`
set); the panel refuses to start with `COMPOSE_PANEL_TRUST_PROXY=true` and no
public origin, since the header would then be client-controlled.

## Manual verification (release gate)

Automated CI builds the image, scans it and runs unit tests, but the
following need a real Linux host with Docker and are done by hand before any
release. Verified 2026-10-10 against image `compose-panel:local`
(linux/amd64, Bun 1.4.2, Compose v5.6.0, Docker Desktop Linux daemon):

- [x] Image builds reproducibly (`docker build -t compose-panel:local .`).
- [x] Login smoke test: login page → 303 login → stack list shows the stack.
- [x] Read: detail page shows the Compose file and the real project state.
- [x] Validate + save: edited service saved (303), file on disk updated.
      Invalid drafts returning 400 is covered by unit tests (`editor` +
      `app` suites), not re-proven against the live daemon.
- [x] `up`: pulls the image, creates network/container, SSE reports
      `succeeded` exit 0; detail shows the real container state afterwards.
- [x] `down`: stack returns to `not-created`, no leftover containers.
- [x] Without a socket mount, `up` fails honestly (`failed`, exit 1, Docker's
      error in the output, state `unknown`) — no invented success.
- [x] Interruption/restart: `docker restart` invalidates the old session
      (`/` → 302, re-login required), health stays `ok`, files intact.
- [x] Removal: deleting the panel container leaves the daemon healthy and
      stack files untouched.
- [x] Reverse proxy mode behind Caddy 2.8.4 with TLS (2026-10-10, WSL Ubuntu
      24.04, fake `docker`): `scripts/proxy-e2e/run.sh` passes 14/14 — Secure
      cookies, foreign Origin and Host refused, forged `X-Forwarded-For` ignored,
      live SSE for actions and logs, UTF-8, sign-out closes open streams.
- [ ] Same check on the target host with its real Caddy and a real stack.

## Audit correction verification

The checklist above refers to the previously built image. Source corrections
after that image require separate verification; no rebuild or deployment was
performed as part of the correction work.

- [x] Isolated Linux child-process fixtures: a mutation runner timeout and a
      provider log abort both terminate a child ignoring `SIGTERM`; split UTF-8
      remains intact. Verified in WSL Ubuntu 24.04 with Bun 1.4.0; CI uses pinned
      Bun 1.4.2, which remains the supported minimum.
- [x] HTTP/provider fixtures: refuse conflicting new project names, drain an
      accepted save, bound a stuck save and refuse overlapping log follows.
- [x] Real config-only Compose verification (WSL, Compose 5.5.1): process
      environment overrides `.env`; `.env` overrides YAML `name:`; YAML name
      overrides the directory fallback. The collision refusal uses fixture
      discovery and real config resolution; no daemon command was issued.
- [ ] Before releasing the rebuilt image, use a disposable Linux daemon to
      create a project from one directory and request `up` from another directory
      with the same `name:` (and then with `COMPOSE_PROJECT_NAME` in `.env`).
      Expect 409 and unchanged original containers. A unique name must use the
      resolved `-p` identity and still work from the ordinary Compose CLI.
- [ ] Follow real logs containing partial lines and non-ASCII text; confirm exact
      text, stop the last reader, then follow again after process termination.
- [ ] Send `SIGTERM` while a save is validating and while an operation is running;
      confirm new requests are refused, accepted work drains within the shared
      deadline and no containers already started are stopped by panel shutdown.

Never use a production daemon for these release checks. Unknown outcomes after
the shared deadline or a crash still require inspecting files and Docker state.
