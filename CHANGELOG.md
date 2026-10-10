# Changelog

## 0.1.0 — to be released

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
