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
- The panel binds **127.0.0.1 only**. With host networking that is the host
  loopback. Remote access goes through `ssh -L5081:127.0.0.1:5081 you@host`.
  Do not publish a port or put the panel behind a proxy until the proxy/TLS
  contract in `docs/security.md` is reviewed.
- Sessions live in memory: every panel restart logs the admin out. No session
  persistence is needed or provided.
- Mounting `/var/run/docker.sock` gives whoever can edit Compose files very
  high control over the host (see `docs/security.md`). Trusted admin only.
- Panel settings must stay in the `COMPOSE_PANEL_*` namespace. Compose
  subprocesses get the process environment with that namespace stripped
  ([ADR 0008](adr/0008-compose-subprocess-environment.md)), so panel secrets
  never reach a stack. Other variables (e.g. `COMPOSE_PROJECT_NAME`,
  `DOCKER_HOST`) pass through by design.

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
