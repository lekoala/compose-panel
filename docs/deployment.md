# Deployment — single Linux host

One panel container, one Docker Engine, one administrator. The panel never
owns your stacks: Compose files on disk and Docker itself stay the sources of
truth, so removing the panel never stops your services.

## Prerequisites

- Linux host with Docker Engine + Compose v2 and the stacks directory
  (e.g. `/opt/stacks`) already managed by `docker compose`.
- Bun 1.4.2+ on the build machine (pinned in CI and the Dockerfile).
- An admin password hash generated **outside** the image:
  `COMPOSE_PANEL_PASSWORD='...' bun run hash-password`.

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
- The panel binds **127.0.0.1 only**. With host networking that is the host
  loopback. Remote access goes through `ssh -L5081:127.0.0.1:5081 you@host`.
  Do not publish a port or put the panel behind a proxy until the proxy/TLS
  contract in `docs/security.md` is reviewed.
- Sessions live in memory: every panel restart logs the admin out. No session
  persistence is needed or provided.
- Mounting `/var/run/docker.sock` gives whoever can edit Compose files very
  high control over the host (see `docs/security.md`). Trusted admin only.

## Backups and rollback

Two layers, both plain files:

1. **Per-save backups** made by the panel itself under
   `<stack>/.compose-panel/backups/<stack>/` (previous `compose.yaml`/`.env`
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
- [ ] Reverse-proxy/TLS exposure: NOT verified — still forbidden (loopback only).
