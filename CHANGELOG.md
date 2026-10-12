# Changelog

## Unreleased (0.3.0)

- Self-update (ADR 0018): a new **About** page (`/about`, in the sidebar) shows
  the panel version and, for the documented Docker deployment with a published
  image, updates the panel itself. **Check for updates** pulls the panel's own
  image tag (`POST /about/check`, touches no container). **Update Compose
  Panel…** (`POST /about/update`, confirmed) starts a one-shot
  `compose-panel-updater` container from the current image, with no network,
  the Docker socket and the deployment directory read-only. The updater checks
  that the tag and the Compose file still match, runs
  `compose up -d --no-deps --no-build --pull never` on the panel service only,
  and waits for the new container to be healthy. The result and output are read
  back from the finished updater container after the restart, with host
  recovery commands on failure. The deployment is read from Docker (own
  container labels), with no new setting. Refused while a stack action or save
  runs; actions, saves and purges are refused while an update runs. Activity log
  events `self-update-check` and `self-update`. New provider calls
  `serviceImage` and `recreateService`; new image entry point
  `src/scripts/self-update.ts`.
- Docs: the upgrade procedure covers the published image as well as local
  builds, and is the recovery path for a failed self-update.
- Stack actions need an honest state (ADR follow-up): `unknown` offers no
  action at all (the server already refused every mutation there through its
  fail-closed project check); the Actions card takes the full state instead of
  a `deployed` boolean.
- New `Start` action (ADR 0019): `docker compose start` on deployed stacks,
  for stopped containers, without recreating anything. `Up` stays the only
  action that creates containers or applies file changes.
- Logs filtered by service (ADR 0020): the Logs card offers a service
  selector and line counts (`100/200/500/1000`, configured
  `COMPOSE_PANEL_LOG_TAIL_LINES` stays the default). `?service=` is validated
  against `config --services` discovery on every request and `?tail=` against
  the offered counts; follows share a subprocess only between identical
  (stack, service, tail) selections, two live selections per stack at most.
- Restart and Up scoped to one service (ADR 0021): the Services table offers
  per-service Restart (`restart --no-deps`) and Up (`up -d --no-deps`, normal
  `Up` semantics — Compose may pull or build) as plain forms. The service is
  validated against `config --services` on every request; scoped `up` never
  creates a stack, and a service field on any other action is refused. The
  service stays visible in the operation panel and the activity log.
- `Pull` downloads non-buildable services only (ADR 0022): `compose pull
  --ignore-buildable`, so stacks mixing registry images and local builds pull
  cleanly in one step (also for `Pull + up`). Services with a `build:`
  section — including ones that also declare `image:` — are skipped and left
  to `Up`.

## 0.2.0

- Backup retention and purge (ADR 0017): after each save the panel keeps the
  `COMPOSE_PANEL_BACKUP_RETAIN` (default 10) most recent backups of each file of
  the stack and deletes older ones. The edit page shows the backup count and
  size, with a confirmed "Delete all backups" action
  (`POST /stacks/<name>/backups/purge`: CSRF, per-stack lock, activity log
  event `backup-purge`). Only files the panel created are counted or deleted.

- Fix: saving a stack keeps the owner and group of `compose.yaml` and `.env`.
  The atomic write (temp file + rename) used to leave both files owned by the
  panel process, so in the root image a user's `.env` became `root:root 0600`
  after an edit and unreadable outside the panel. A new `.env` is now owned
  like the Compose file. Best effort when the panel does not run as root.

- Navigation sidebar (ADR 0016): primary navigation (Stacks, Containers, Server,
  Activity log, Access) moves from the footer into a persistent sidebar shown on
  every authenticated page, together with the list of stacks and the current
  stack highlighted. The stack list comes from the stacks folder alone
  (`listStacks`): no Docker call, status, counter or badge is added to the
  navigation. A local search box filters the sidebar and the stacks table
  (vanilla JS; without JavaScript every entry stays visible) and the sidebar
  collapses into a native `<details>` disclosure on small screens. Presentation
  only: no route, backend or Docker behaviour changes, and each page adds at most
  one cheap directory read.

- Read-only Server page (ADR 0015): `GET /server` (linked in the navigation) shows
  Docker's own diagnostics. Engine facts come from `docker info`, projected onto
  a fixed field whitelist so registry, proxy and environment configuration never
  reach the page. Per-container and per-stack CPU/memory come from
  `docker stats --no-stream` (a top-consumers table, plus a stack total whose CPU
  is cumulative and may exceed 100 %); a "Needs attention" list reports the
  current state (`unhealthy`, `restarting`, non-zero exit) with no history.
  Docker-managed storage (`docker system df`) is read **on demand only** (a link,
  served through a short in-memory cache, `COMPOSE_PANEL_DISK_USAGE_TTL_MS`)
  because it can be expensive on a large host. The three calls extend the
  read-only `ContainerInspector` boundary; a collection that fails shows a note
  and stays unavailable rather than reporting zero. An opt-in **Live** toggle
  refreshes only the dynamic zones (running count, per-stack usage, top
  containers, attention) every 15 s from a bounded JSON endpoint
  (`GET /server/stats`), with sequential requests, paused while the tab is
  hidden and stopped after a `401`; the static engine facts and the disk-usage
  snapshot are never part of it and no history is kept. No host agent is
  involved: host load, memory, uptime, filesystems and package updates stay out
  of scope.

- Docker container inspection (ADR 0014): a read-only view of the containers the
  panel does not manage. The home page gains an **Other containers** section and
  a **Containers** page (`/containers`, linked in the navigation) lists every
  container Docker reports, grouped by `Managed`, `External Compose` and
  `Standalone`, with `Running` / `Stopped` / `All` filters (plain links, no
  JavaScript). A container whose membership is not certain stays *External*; a
  managed container is matched by its Compose file path (with an optional
  `COMPOSE_PANEL_STACKS_PATH_ALIASES=hostPrefix=panelPrefix` remap for migrations
  where the Docker-side path differs) or, when no file is recorded, by a project
  name that matches exactly one deployed stack. Each container has a read-only
  detail page (`/containers/<id>`) with the status, health, restart policy,
  created/started times, published ports (with an honest "All interfaces" mark, no
  claim of reachability), mounts collapsed behind a disclosure, and a bounded log
  snapshot (`/containers/<id>/logs`, plain text, `no-store`, `--tail` allow-listed
  and ANSI stripped). It is observation only: no start, stop, restart, remove or
  exec, and no raw `docker inspect` — the environment (`Config.Env`) and arguments
  are never shown. Lower-level Docker calls live in a separate `ContainerInspector`
  boundary, not in the Compose provider.

- Multiple access origins (ADR 0012): HTTPS and the SSH tunnel can be used at
  the same time, and several reverse-proxy origins (a public domain next to a
  private overlay name) can be allowed without the panel knowing Caddy,
  Tailscale or SSH. `COMPOSE_PANEL_PROXY_ORIGINS=https://a,https://b` lists the
  allowed origins; each request is resolved to an access point from its Host and
  its Origin/Host, cookie `Secure` attribute and X-Forwarded-* trust follow that
  point.   `COMPOSE_PANEL_ALLOW_LOOPBACK=true` keeps the loopback path alongside
  the origins (implicit when none are configured). Entries are validated at
  startup: https only (outside `COMPOSE_PANEL_DEV`), no credentials, path,
  query, fragment, empty entry or duplicate. The documented trust boundary is
  pinned by tests: Host does not authenticate the proxy, only the last
  `X-Forwarded-For` entry is read (vendor headers such as `CF-Connecting-IP` are
  ignored), and the panel never delegates its authentication to an identity
  proxy. A Cloudflare Access + Tunnel case is documented (not code). **Breaking
  config change:**
  `COMPOSE_PANEL_PUBLIC_ORIGIN` and `COMPOSE_PANEL_TRUST_PROXY` are refused at
  startup with a migration message (never silently reinterpreted). The
  `scripts/proxy-e2e/run.sh` check now covers two origins plus the coexisting
  loopback path.

  ```sh
  # Before
  COMPOSE_PANEL_PUBLIC_ORIGIN=https://panel.example.com
  COMPOSE_PANEL_TRUST_PROXY=true
  # After — proxy only
  COMPOSE_PANEL_PROXY_ORIGINS=https://panel.example.com
  # After — HTTPS and the SSH tunnel together, with a second private origin
  COMPOSE_PANEL_PROXY_ORIGINS=https://panel.example.com,https://oracle-ampere.example.ts.net
  COMPOSE_PANEL_ALLOW_LOOPBACK=true
  ```

- Access diagnostics (ADR 0013): a read-only **Access & security** page
  (`/access`, linked in the navigation) shows the access point the current request
  arrived on and a table of the configured paths with an honest status —
  *verified by the panel* (loopback bind, authentication, CSRF/Origin checks,
  the https scheme), *configured but unverified* (a proxy origin's network
  restriction), or *verify externally* (whether a tunnel is open, whether a
  firewall/VPN/allow-list really restricts access). It never marks an access
  secure from its configuration alone, and it adds no privilege, host command
  or Tailscale/systemd socket. Richer host diagnostics are deferred to the
  roadmap.
- Documentation from a real migration: the deployment guide generates the
  admin password hash with the image itself (no Bun on the host) and warns that
  the Argon2id hash must be single-quoted in `env_file`, where Docker Compose
  would otherwise interpolate its `$`; the Dockge guide adds a
  `docker inspect` check for existing projects, a post-switch checklist and how
  to find the active Caddy configuration; a new `docs/troubleshooting.md`
  covers refused sign-ins (origin vs CSRF), missing/`unknown` stacks, empty
  logs, the health column, host-vs-container Compose, Caddy configs and zombie
  processes (`init: true`).
- Logs on open: the stack page now shows the last
  `COMPOSE_PANEL_LOG_TAIL_LINES` (200) lines as soon as it loads, instead of an
  empty box until *Follow logs* is clicked. A new bounded, read-only
  `readLogs` operation on the `ComposeProvider` backs a `GET /stacks/<name>/logs`
  snapshot (plain text, `no-store`); *Refresh* re-reads it and *Follow live*
  keeps the existing SSE follow, whose replay replaces the shown history so
  nothing is duplicated. No permanent process runs for a snapshot, Docker stderr
  is never echoed, and the read is bounded by the Docker timeout and output cap.
  Logs Docker has already rotated away cannot be recovered. A browser without
  JavaScript can open the *Latest lines* link to read the same snapshot.
- Service health: the *Health check* column is hidden entirely when no service
  declares a health check, and otherwise shows `Healthy`, `Unhealthy`,
  `Starting` or `Not configured`. An unhealthy service is also surfaced as a
  separate `Health: N unhealthy` badge beside the run-state badge, so a running
  container with a failing health check is never confused with a stopped one.

## 0.1.0 — 10-10-2026

First minimal release. Single Linux host, single trusted administrator,
always bound to `127.0.0.1`; remote access through an SSH tunnel or HTTPS with
Caddy on the same host.

- Lifecycle test on a disposable daemon: `scripts/docker-lab/run.sh`
  (`bun run test:docker-lab:wsl`) starts a labelled Docker-in-Docker daemon on
  a private Unix socket and runs `tests/docker-lifecycle-linux.test.ts` against
  the real server: project collisions by `name:` and `.env` are refused with
  no container created, and `SIGTERM` during a delayed `up` refuses new actions,
  drains within the grace period and leaves containers running. Opt-in only;
  the test refuses any daemon without the lab label or with containers.
- Security review 2026-10-10 fixes:
  saves and operations re-check the session after reading the body, after
  project discovery and before writing, so a request left pending across logout
  or expiry does nothing (SEC-01); the default audit layout is lstat-checked
  from the stacks root down for writes, reads and pruning (SEC-02); validation
  errors redact the longest values first and multiline quoted values, and a
  diagnostic cut by the runner is replaced by a fixed message (SEC-03); audit
  retention only lists and deletes regular `<period>.log` files (SEC-04); login
  tracking is capped at 10,000 client keys with amortized expiry (SEC-05).
- Image maintenance: the base image reference is literal so Dependabot can
  propose Bun digest refreshes; CI also runs weekly so new fixable CVEs and
  expired Trivy exceptions surface without a push. Documentation no longer
  claims byte-for-byte reproducible builds (apt resolves some packages at
  build time).

- Display time zone: container logs (`compose logs --timestamps`), the activity
  log and action start times are shown in one zone. `COMPOSE_PANEL_TIMEZONE`
  (an IANA name such as `Europe/Brussels`) fixes it for every reader; unset uses
  each reader's browser zone. Stored and emitted timestamps stay UTC; an invalid
  zone is refused at startup.
- Reverse proxy mode (ADR 0010): `COMPOSE_PANEL_PUBLIC_ORIGIN=https://…` alone
  turns on Secure cookies and the forwarded client address for a TLS proxy on
  the same host; the bind stays hard-coded to loopback, so a port mapping cannot
  expose the panel. Inconsistent settings are refused at startup (plain-http
  public origin, Secure cookies or forwarded address switched off, forwarded
  address trusted without a proxy). Caddy setup, caddy-docker-proxy labels and
  a recommended second barrier are documented; `scripts/proxy-e2e/run.sh`
  (`bun run test:proxy:wsl`) checks the contract against a real Caddy with TLS.
- Pull on its own and "Update ready" (ADR 0011): `Pull` downloads newer images
  without touching containers; each service whose container runs an older image
  than its tag now points to shows "Update ready" with from → to (OCI version
  label, else build date, else digest) and a link to the release notes, source
  or Docker Hub page. Derived locally from `compose images` and `image inspect`,
  read-only; label URLs are validated and escaped.
- Migration guide from Dockge (`docs/migrating-from-dockge.md`): compatibility
  check script, `global.env`, backup, switch-over without stopping stacks,
  closing Dockge's exposed port, rollback.
- `bun run preview`: the real panel on demo stacks with a simulated Docker
  (no command runs), to try every page, action and stream without any setup.
- Activity audit and login backoff (P7, ADR 0009): an append-only NDJSON
  activity log (daily files under `.compose-panel/audit/`, retention, bounded
  reads, per-file size cap, per-minute cap on sign-in noise) records sign-ins,
  saves and operation starts and outcomes without passwords, hashes, `.env`
  values or typed usernames, exposed through a read-only `/audit` page behind
  auth. Per-client login lockout is replaced by a bounded progressive delay with
  one attempt in progress per client, so a single source cannot lock the
  administrator out; the global verification cap is taken after the delay and
  only answers a transient `429` under distributed load. Behind a trusted proxy
  the client is the last `X-Forwarded-For` entry.
- Verify effective names and collisions before creating Compose projects, pin
  creation identity, reserve project names during panel operations, and end log
  follows for undeployed stacks without a subprocess.
- Drain accepted saves during shutdown and pin Linux stack directories open
  during validation to prevent inode reuse from hiding replacements.
- Bound subprocess termination with signal escalation; keep mutation locks and
  log ownership when child exit cannot be confirmed.
- Preserve streamed text fragments, CRLF and split UTF-8 through the runner,
  SSE frames and browser. Add isolated Linux process and browser regressions.
- Security audit follow-up:
  reserve a login attempt synchronously before password verification with a
  global in-flight cap (a burst can no longer exceed the limit); bind SSE
  streams to their session so logout closes them and expiry stops them at the
  next heartbeat; apply the editor's `.env` safety rules to mutations and log
  follows and pass a verified `.env` explicitly with `--env-file`; follow the
  `.env` value syntax when collecting redaction secrets and redact before
  truncating; validate the `Host` header against loopback and the configured
  public origin before routing; strip the `COMPOSE_PANEL_*` namespace from
  Compose subprocesses per ADR 0008.
- Review follow-up on that remediation: draft validation now uses the same
  environment context as a mutation (live `.env` passed explicitly) so the two
  cannot diverge via implicit `COMPOSE_ENV_FILES`; the SSE session is re-checked
  just before subscribing so a logout during discovery cannot register a stream;
  escaped quotes inside single-quoted `.env` values are handled by the secret
  collector; the CI production-boot step fails explicitly if the server never
  becomes ready.
- Login UX: a blocked Origin (mismatch or the opaque `null` of an embedded
  context) now answers a `303` back to `/login` with an explanation instead of a
  bare `403`. The check stays strict by default; the opt-in
  `COMPOSE_PANEL_ALLOW_OPAQUE_ORIGIN` (local testing only) accepts an absent or
  opaque Origin when Fetch Metadata says same-origin/none, never a cross-site
  frame.
- Common/guessable admin usernames (`admin`, `administrator`, `root`, `user`,
  `test`, `guest`) are refused at startup unless `COMPOSE_PANEL_DEV=true`
  (development only). First-party examples, the deployment env sample and the CI
  smoke test now use a unique username.
- Interface: every label and message rewritten to say what happened and what
  to do next ("Nothing was run", "Saving does not restart anything: use Up");
  one-line help per action; actions locked while one runs and, on an undeployed
  stack, the ones that need a deployment; a reload link when an action ends;
  service badges (an init job that exited 0 shows as done); stack list as a
  table with a summary and an explanatory empty state; readable pages instead
  of bare `401`/`403`/`413` text; a standalone centered sign-in page. Local
  times, scroll-aware live output, double-submit guard, unsaved-changes warning
  and Ctrl/Cmd+S in the editor. Down asks for an explicit second click (works
  without JS); `.env` values are hidden until "Show values" is clicked; Tab
  indents in the editor (Esc, then Tab, leaves the field). Self-contained stylesheet with light/dark color
  tokens, laid out for phones (44 px touch targets, 16 px fields, no
  horizontal scroll).
- A draft kept after a failed save keeps the file versions it was based on, so
  a change made on disk in the meantime is still detected as a conflict instead
  of being overwritten by the next save.
- Supply-chain hardening: base image pinned by version and multi-arch digest,
  every GitHub Action pinned to a commit SHA, and Trivy failing on
  `CRITICAL,HIGH` for both the repository (dependencies + secrets) and the
  built image. OCI `org.opencontainers.image.*` labels (title, description,
  source, licenses, version, revision) are embedded; the icon itself remains a
  registry-side setting.
- Toolchain: Bun 1.4.3 with the built-in `bun check` type checker (`typescript`
  removed), `bun audit` and a production-only boot check in CI, and trapped-name
  and missing-STACKS_DIR regression tests.
- Single-admin auth: Argon2id password hash, in-memory sessions (idle +
  absolute timeouts, rotation on login), per-session CSRF + strict
  Origin/Referer checks, login rate limiting, bounded bodies, `no-store`.
- Real Docker state: bounded `compose ls`/`ps` behind the `ComposeProvider`
  boundary; project identity resolved from Docker, never assumed from the
  folder name; honest `active/stopped/unknown` statuses.
- Safe raw editing of `compose.yaml` and `.env` (no YAML round-trip):
  optimistic concurrency via content hashes, validation with
  `docker compose config --quiet` in the real project context, atomic writes
  preserving file modes, per-save backups with rollback plan, one operation
  per stack.
- Predefined operations (`up`, `stop`, `restart`, `down`, `pull + up`) with a
  fixed allow-list and explicit argument arrays (no shell); one per stack;
  in-memory, browser-independent; success only on exit 0; bounded drain on
  shutdown; no persistence, no replay — outcome unknown after a crash.
- Live streams over authenticated SSE: operation output (observe-only) and
  `compose logs --follow` (one subprocess per stack, killed when the last
  reader leaves); heartbeat, explicit timeouts, subscriber cap, slow-reader
  drops, ANSI stripped, `textContent`-only rendering.
- Linux packaging: multi-stage Dockerfile (Bun + pinned Docker CLI 29.9.0 +
  Compose plugin 5.6.0, verified in build), `deploy/compose.yaml` (host networking,
  `stop_grace_period` past the drain window), backup/rollback and manual
  verification in `docs/deployment.md`; Linux CI (tests, image build,
  socket-less smoke test, Trivy scan) that never publishes.
- Pre-release security audit (2026-10-10, report in `private/`): fail-closed
  project context for mutations and follows (no blind `-p`-less control),
  post-validation re-check with backups-first saves and explicit partial
  failures, symlink-confined owner-only backups, instance-owned log streams,
  bounded shutdown refusing new work, and live operation progress with
  drain-instead-of-cancel pipe handling.

Known limitations: bound to loopback only (SSH tunnel, or Caddy on the same
host with host networking; only Caddy is tested); no guaranteed operation outcome after a crash; multi-file
Compose (override files) rejected; Docker Compose only, no Podman yet;
sessions lost on restart (re-login required).

Licensed under the EUPL-1.2, copyright 2026 LeKoala.
