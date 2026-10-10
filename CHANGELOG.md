# Changelog

## Unreleased

- Verify effective names and collisions before creating Compose projects, pin
  creation identity, reserve project names during panel operations, and end log
  follows for undeployed stacks without a subprocess.
- Drain accepted saves during shutdown and pin Linux stack directories open
  during validation to prevent inode reuse from hiding replacements.
- Bound subprocess termination with signal escalation; keep mutation locks and
  log ownership when child exit cannot be confirmed.
- Preserve streamed text fragments, CRLF and split UTF-8 through the runner,
  SSE frames and browser. Add isolated Linux process and browser regressions.

## 0.1.0 — 2026-10-10

First minimal release. Single Linux host, single trusted administrator,
loopback HTTP only (`127.0.0.1`, no proxy/TLS yet).

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
