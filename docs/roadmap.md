# Roadmap and PR order

Each step creates a functional, verifiable slice. Do not carry out mutations in parallel with authentication.

## P0 — Initial slice: local read-only
- [x] Bun repo + server-rendered HTML + zero runtime npm dependencies.
- [x] Compose discovery and reading, rejection of obvious symlink names/paths.
- [x] Unit tests for the file core and HTML escaping.
- [x] Run `bun install`, `bun run test`, `bun run check` on a machine equipped with Bun.

## P1 — Security entry / identity (agent 01)
- [x] Single-admin auth + correctly signed/stored session + logout.
- [x] CSRF, Origin/Host, HTTP limits, `no-store` and masked secrets.
- [x] Auth required for any Compose read and future mutating endpoints.
- [x] Tests for login, CSRF, session, error reporting.

## P2 — Real stack state (agent 02)
- [x] Bounded Docker CLI call for `compose ls` and `compose ps`.
- [x] Do not assume folder name == project identity.
- [x] Honest status: active/stopped/unknown; handling of init jobs exiting 0.
- [x] Integration test on a disposable Docker daemon (opt-in, read-only).

## P3 — Safe editing (agent 03)
- [x] Edit raw `compose.yaml` and `.env`; conflict via hash/If-Match.
- [x] Validate the draft in the same Compose context (directory, multiple files, env and identity).
- [x] Best-effort atomic backup, restore plan if only one of the 2 files changed.
- [x] Size limits, file modes, symlinks, no secret leakage.

## P4 — Operation management (agent 04)
- [x] `up`, `stop`, `restart`, `down`, `pull+up` with immutable/controlled arguments.
- [x] In-memory lock per stack, also for saving.
- [x] Drain `SIGTERM`, timeout, concurrency rejection, tracking independent of the tab.
- [x] After a crash: the UI re-reads Docker and does not announce an unconfirmed success.

## P5 — Logs and SSE (agent 05)
- [x] SSE subscription to existing operation output, disconnect ≠ cancellation.
- [x] Compose follow logs separated, killed when the last reader leaves.
- [x] Backpressure, buffer limit, heartbeat, explicit timeout.

## P6 — Linux production (agent 06)
- [x] Multi-stage image with Bun, Docker CLI and Compose plugin installed and verified.
- [x] Isolated CI, linux/amd64 build at minimum, real smoke tests.
- [x] `stop_grace_period`, restart, mount, backups, rollback procedure documented.
- [x] Release candidate after file, security and interruption tests.

**V1 completion criterion**: the admin can edit a stack and request `up`, disconnect the browser, find the real status again, stop the panel without affecting containers already running. No dishonest guarantees after a hard crash.

## Post-V1 (not scheduled, not claimed)
- Engine-neutral completion: a Podman `ComposeProvider`, validated by integration tests on `config`, `ps`, `pull`, `up`, `down`, project names and file mounts before any compatibility is announced. The boundary exists now (ADR 0005); no Podman support is claimed in V1.
