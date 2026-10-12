# Deployment — single Linux host

One panel container, one Docker Engine, one administrator. The panel never
owns your stacks: Compose files on disk and Docker itself stay the sources of
truth, so removing the panel never stops your services. For sign-in, stack or
log problems, see [troubleshooting.md](troubleshooting.md).

## Prerequisites

- Linux host with Docker Engine + Compose v2 and the stacks directory
  (e.g. `/opt/stacks`) already managed by `docker compose`.
- Docker to build or pull the image. No Bun install is needed on the host: the
  image runs `hash-password` for you below. Bun 1.4.3+ is only needed to build
  the image (pinned in CI and the Dockerfile).
- A unique admin username (`COMPOSE_PANEL_ADMIN_USER`): common names
  (`admin`, `root`, …) are refused at startup unless `COMPOSE_PANEL_DEV=true`.

## Deploy

Build or pull the image **before** generating the hash, so the image can
generate it for you:

```sh
# 1. Copy the settings and build (or pull) the image
cp deploy/compose-panel.env.example deploy/compose-panel.env
docker compose -f deploy/compose.yaml build

# 2. Generate the admin password hash with the image itself
read -rsp "Compose Panel password: " COMPOSE_PANEL_PASSWORD; echo
export COMPOSE_PANEL_PASSWORD
docker run --rm --entrypoint bun -e COMPOSE_PANEL_PASSWORD \
  compose-panel:local src/scripts/hash-password.ts
unset COMPOSE_PANEL_PASSWORD

# 3. Paste the hash, single-quoted, and a unique username into
#    deploy/compose-panel.env, then lock the file down and start
chmod 600 deploy/compose-panel.env
docker compose -f deploy/compose.yaml up -d
curl -fsS http://127.0.0.1:5081/health/live  # -> ok
```

The hash must be **single-quoted** in `compose-panel.env`: Docker Compose
applies variable interpolation to unquoted and double-quoted `env_file` values,
so a `$` in the Argon2id hash would be expanded and the panel would reject the
password. On a machine that already has Bun you can instead run
`COMPOSE_PANEL_PASSWORD='...' bun run hash-password`.

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

## Upgrading from 0.1.0

0.2.0 replaces the single `COMPOSE_PANEL_PUBLIC_ORIGIN` with the list
`COMPOSE_PANEL_PROXY_ORIGINS`, and removes `COMPOSE_PANEL_TRUST_PROXY` (the
forwarded address is now trusted per matched origin automatically). Both old
settings are refused at startup with a migration message — the panel never
reinterprets security configuration silently ([ADR 0012](adr/0012-multiple-access-origins.md)).

```sh
# 0.1.0
COMPOSE_PANEL_PUBLIC_ORIGIN=https://panel.example.com
COMPOSE_PANEL_TRUST_PROXY=true

# 0.2.0 — reverse proxy only
COMPOSE_PANEL_PROXY_ORIGINS=https://panel.example.com
# 0.2.0 — HTTPS and the SSH tunnel together
COMPOSE_PANEL_PROXY_ORIGINS=https://panel.example.com
COMPOSE_PANEL_ALLOW_LOOPBACK=true
```

A single origin behaves as before. The change is that the SSH tunnel and HTTPS
no longer exclude each other, and several origins can be listed.

## Behind Caddy (HTTPS)

To use the panel from a browser without a tunnel, put Caddy in front of it on
the **same host** ([ADR 0010](adr/0010-reverse-proxy-mode.md)). The panel stays
bound to `127.0.0.1`, so Caddy must reach the host loopback: run it on the host
itself, or in a container with `network_mode: host`.

> **Version note.** The list setting below (`COMPOSE_PANEL_PROXY_ORIGINS`) is the
> 0.2.0 contract ([ADR 0012](adr/0012-multiple-access-origins.md)). On 0.1.0 the
> equivalent is the single `COMPOSE_PANEL_PUBLIC_ORIGIN=https://…`; see
> [Upgrading from 0.1.0](#upgrading-from-010).

1. In `deploy/compose-panel.env`, list the origins. This setting allows HTTPS
   access and makes Secure cookies and Caddy's `X-Forwarded-For` apply on those
   hosts:

   ```sh
   COMPOSE_PANEL_PROXY_ORIGINS=https://panel.example.com
   ```

   Each entry must be `https` (outside `COMPOSE_PANEL_DEV=true`), with no
   credentials, path, query or fragment, no empty entry and no duplicates.
   Several origins are comma-separated:

   ```sh
   # A public domain and a private overlay name, for example
   COMPOSE_PANEL_PROXY_ORIGINS=https://dockge.example.com,https://oracle-ampere.example.ts.net
   ```

   With no origin listed, the SSH tunnel is the only path. To keep using the
   tunnel *and* the proxy, opt in explicitly:

   ```sh
   COMPOSE_PANEL_ALLOW_LOOPBACK=true
   ```

   Upgrading from 0.1.0: `COMPOSE_PANEL_PUBLIC_ORIGIN` is refused at startup —
   rename it to `COMPOSE_PANEL_PROXY_ORIGINS`, and remove any
   `COMPOSE_PANEL_TRUST_PROXY` (forwarded headers now follow the matched origin
   automatically). See [ADR 0012](adr/0012-multiple-access-origins.md).

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

3. Restart the panel and check that it says `Reverse proxy mode: origins
   https://panel.example.com; ...` at startup. Sign in through the public URL.
   With `COMPOSE_PANEL_ALLOW_LOOPBACK=true`, the SSH tunnel
   (`ssh -L5081:127.0.0.1:5081 you@host`) keeps working alongside it: each path
   is validated on its own — a form built for the proxy origin is refused when
   posted through the tunnel and the reverse — and only the HTTPS path sets
   Secure cookies.

   With several proxy origins, Caddy serves each name and forwards to the same
   panel; no second panel is needed:

   ```caddyfile
   dockge.example.com {
   	reverse_proxy 127.0.0.1:5081
   }
   oracle-ampere.example.ts.net {
   	reverse_proxy 127.0.0.1:5081
   }
   ```

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

**Review what is configured.** Once signed in, the read-only `Access & security`
page (`/access`) lists the loopback path and every proxy origin with an honest
status ([ADR 0013](adr/0013-access-diagnostics.md)): what the panel verified
itself, what is configured but unverified (a proxy origin's network restriction),
and what only you can check (whether a tunnel is open, whether a firewall or VPN
really restricts access). It never marks an access secure from its configuration
alone.

## Private access (Tailscale Serve)

If the panel does not need to be reachable from the internet, expose it only on
a private network. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
publishes a local service over HTTPS to the members of your tailnet, with no
public port and no Caddy:

```sh
# On the host, after `tailscale up` (with MagicDNS and HTTPS enabled):
tailscale serve --bg --https=443 http://127.0.0.1:5081
tailscale serve status   # prints https://<host>.<tailnet>.ts.net
```

Then list that `ts.net` origin and keep the SSH tunnel as a fallback (0.2.0):

```sh
COMPOSE_PANEL_PROXY_ORIGINS=https://oracle-ampere.example-tailnet.ts.net
COMPOSE_PANEL_ALLOW_LOOPBACK=true
```

Use `tailscale serve`, never `tailscale funnel`: Funnel would publish the panel
to the public internet. Tailscale is only an access path here — the panel keeps
its own password, so it stays optional and is never a dependency. A Caddy site
bound to the private interface, or an IP allow-list in front of a public Caddy
site, are equally valid alternatives; use whichever your network already has.

## Behind Cloudflare Access + Tunnel (identity proxy)

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
publishes the panel without opening an inbound port, and
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
checks an identity before the request reaches it. The panel is not modified and
does not know Cloudflare: `cloudflared` is just another reverse proxy on the
same host, reaching the loopback listener, so the rules above apply unchanged.

1. Install `cloudflared` on the host and point the tunnel's origin at the panel.
   With a locally-managed tunnel:

   ```yaml
   # ~/.cloudflared/config.yml
   tunnel: <tunnel-id>
   ingress:
     - hostname: panel-cf.example.com
       service: http://127.0.0.1:5081
     - service: http_status:404
   ```

2. List the tunnel hostname as a proxy origin, exactly as for Caddy. If it sits
   next to an existing Caddy site and the SSH tunnel:

   ```sh
   COMPOSE_PANEL_PROXY_ORIGINS=https://dockge.example.com,https://panel-cf.example.com
   COMPOSE_PANEL_ALLOW_LOOPBACK=true
   ```

   The panel keeps its own sign-in, sessions and CSRF; facing the same origin
   with two proxies (for example Caddy and the tunnel) needs no extra setting.

3. **Create and verify the Access policy before publishing the route.** A
   Cloudflare Tunnel route with no protecting Access application is reachable
   publicly, and protecting the hostname does nothing if another network path
   to the panel bypasses Access. Enable *Protect with Access* on the tunnel so
   `cloudflared` validates the access token itself, restrict the policy to the
   identities that may use the panel, and keep the SSH tunnel as a fallback for
   when Cloudflare is unreachable.

Notes on the trust chain:

- The panel authorizes on its own password and CSRF token only. It never treats
  a request as authorized because it carries a Cloudflare or identity header.
- Only the **last** `X-Forwarded-For` entry is read — the one the local proxy
  (`cloudflared`) appended. Vendor identity headers such as `CF-Connecting-IP`
  are ignored. Do not read them in the panel's name elsewhere.
- Placing Cloudflare **in front of Caddy** (instead of tunnelling straight to
  the panel) makes the last `X-Forwarded-For` entry Caddy's connecting address,
  i.e. a Cloudflare edge address, not the visitor. If you need the real client
  address in the audit log, terminate at the panel with one trusted proxy.

This path is documented, not covered by the end-to-end test (only Caddy is
tested). Verify it on your own host before relying on it.

## Backups and rollback

Two layers, both plain files:

1. **Per-save backups** made by the panel itself under
   `<root>/.compose-panel/backups/<stack>/` (previous `compose.yaml`/`.env`
   before each write). To roll a stack back, copy the backup over the live
   file, then `docker compose up -d` from that directory. The panel keeps the
   `COMPOSE_PANEL_BACKUP_RETAIN` (default 10) most recent backups of each file
   and deletes older ones after a save. "Delete all backups" on a stack's edit
   page removes them at once, for example after rotating a secret in `.env`
   (backups of `.env` contain its secrets). Only files the panel created are
   counted or deleted (ADR 0017).
2. **Host-level stacks backup** before upgrades or risky edits:
   `tar -czf /root/stacks-backup-$(date +%F).tar.gz -C /opt stacks`.
   Restore with `tar -xzf`, then re-read state in the panel.

### Updating from the browser

With a published image, **About** (`/about`) updates the panel itself
([ADR 0018](adr/0018-self-update.md)):

1. **Check for updates** pulls the image tag the panel runs from. Nothing
   restarts. Use `image: ghcr.io/lekoala/compose-panel:latest` in
   `deploy/compose.yaml` to follow releases: a version tag such as `0.3.0`
   never moves, so a check finds nothing newer.
2. When the tag points to a newer image, **Update Compose Panel…** shows both
   versions and asks for a confirmation. It is refused while a stack action or
   save is running.
3. The panel starts a one-shot container, `compose-panel-updater`, from the
   image it runs now, with no network, the Docker socket and the deployment
   directory (read-only). The updater checks that the tag and the Compose file
   still match, runs `docker compose up -d --no-deps --no-build --pull never panel`,
   then waits until the new container is healthy. Managed stacks are not
   touched.
4. The page reloads by itself when the panel is back. Sign in again (sessions
   live in memory). **About** shows the result and the updater output, read
   from the finished updater container. It stays in Docker until the next update
   (`docker logs compose-panel-updater` works from the host too).

Requirements, all read from Docker (no setting): the panel runs in a container
started by `docker compose`, from a pulled image tag (not a local build, not
pinned by digest), with the socket bind-mounted at `/var/run/docker.sock`, and
all its Compose and env files inside the deployment directory. If one is
missing, **About** says which and the update is done from the host as below.
The updater applies the deployment files as they are on disk, like a manual
`compose up`. It does not depend on the panel process: if the panel is stopped
or restarted during an update, the updater keeps going, and the next panel
start shows its outcome. It never rolls back by itself: if it fails, **About** shows the
commands to run on the host.

### Upgrade and rollback

Run these commands **on the host**, from the repository checkout, never from
inside the panel: recreating the panel container stops the process that would
run them. This is also the recovery path when an update from the browser fails.

1. Back up (layer 2).
2. Built locally: `git pull` (or check out the new tag), then
   `docker compose -f deploy/compose.yaml build`.
   Published image: set `image: ghcr.io/lekoala/compose-panel:<version>` in
   `deploy/compose.yaml`, then `docker compose -f deploy/compose.yaml pull panel`.
3. `docker compose -f deploy/compose.yaml up -d --no-deps panel`, then run the
   smoke checks below.

Rollback: check out the previous tag/commit and rebuild, or put the previous
version tag back in `image:` and pull, then `up -d --no-deps panel` again.
Stack files are untouched in either direction, and managed stacks keep running
while the panel restarts.

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
`COMPOSE_PANEL_AUDIT_RETAIN_FILES`, `COMPOSE_PANEL_AUDIT_MAX_FILE_BYTES`,
`COMPOSE_PANEL_AUDIT_MAX_READ_LINES`.

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

Forwarded addresses are trusted only on a request whose Host matches a
`COMPOSE_PANEL_PROXY_ORIGINS` entry; through the loopback (SSH) path
`X-Forwarded-For` is ignored and `actor` is `direct`. Note the trust boundary
([ADR 0012](adr/0012-multiple-access-origins.md)): a client able to reach the
loopback listener can present a proxy-origin Host and forge the header, so this
is a best-effort attribution, not an authenticated proxy identity.

## Manual verification (release gate)

Automated CI builds the image, scans it and runs unit tests, but the
following need a real Linux host with Docker and are done by hand before any
release. Verified 2026-10-10 against image `compose-panel:local`
(linux/amd64, Bun 1.4.3, Compose v5.6.0, Docker Desktop Linux daemon):

- [x] Image builds (`docker build -t compose-panel:local .`).
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
- [x] Multiple access origins ([ADR 0012](adr/0012-multiple-access-origins.md)):
      `scripts/proxy-e2e/run.sh` with two TLS origins and the coexisting loopback
      path passes 20/20 (2026-10-11, WSL Ubuntu 24.04, fake `docker`) — both
      origins accepted with Secure cookies, loopback non-Secure, a cross-path
      Origin refused.
- [ ] Same check on the target host with its real Caddy and a real stack.
- [x] Self-update logic ([ADR 0018](adr/0018-self-update.md)) on the disposable
      lab daemon (`bun run test:docker-lab:wsl`, 2026-10-12, Docker 29.9.0):
      real Compose labels are read, a stale target is refused with nothing
      changed, the retagged service is recreated and verified healthy, and a
      second service keeps its container.
- [x] Targeted operations, filtered logs and pull policy ([ADR 0019](adr/0019-start-action.md),
      [ADR 0020](adr/0020-filtered-service-logs.md),
      [ADR 0021](adr/0021-targeted-service-operations.md),
      [ADR 0022](adr/0022-pull-ignores-buildable-services.md)) on the disposable
      lab daemon (`bun run test:docker-lab:wsl`, 2026-10-12, Docker 29.8.1):
      `start` brings stopped containers back, scoped `restart --no-deps` leaves
      a stopped dependent alone, scoped `up --no-deps` does not start
      dependencies, `?service=&tail=` reads through the `--` separator,
      `config --services` discovery and refusals work, and `pull` succeeds on a
      stack mixing registry, build-only and image+build services (the local
      ones are skipped, then built by `up`).
- [ ] Self-update end to end with the published image on a disposable host:
      deploy `ghcr.io/lekoala/compose-panel:latest` at the previous version,
      publish the new one, Check, Update; the panel comes back on the new
      version, `compose-panel-updater` exited 0, managed stacks untouched. Then
      make it fail (for example change `image:` in `deploy/compose.yaml`) and
      confirm "Refused, nothing changed" with the panel still running.

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
