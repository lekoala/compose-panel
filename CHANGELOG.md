# Changelog

## 0.1.0 — to be released

First minimal release. Single Linux host, single trusted administrator,
loopback HTTP only (`127.0.0.1`, no proxy/TLS yet).

- Activity audit and login backoff (P7, ADR 0009): an append-only NDJSON
  activity log (daily files under `.compose-panel/audit/`, retention, bounded
  reads) records sign-ins, saves and operation starts without passwords, hashes
  or `.env` values, exposed through a read-only `/audit` page behind auth.
  Per-client login lockout is replaced by a bounded progressive delay so a valid
  administrator is never refused; only a transient global in-flight cap answers
  `429`.

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

Known limitations: loopback only (reach remotely via SSH tunnel, never a
public port); no guaranteed operation outcome after a crash; multi-file
Compose (override files) rejected; Docker Compose only, no Podman yet;
sessions lost on restart (re-login required).

Licensed under the EUPL-1.2, copyright 2026 LeKoala.
