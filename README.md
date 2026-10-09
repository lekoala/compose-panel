# Compose Panel

A **single-server** panel to administer Docker Compose stacks, without a SPA, without an ORM and without a parallel orchestrator. The goal is a small, self-hosted tool that keeps Compose files as the source of truth.

> **Current state: authenticated, read-only + editing + operations, NOT production-ready.** A single administrator logs in; the raw `compose.yaml` and `.env` can be edited with validation and backups, and predefined operations (`up`, `stop`, `restart`, `down`, `pull + up`) run in the background. It still listens on **`127.0.0.1` only** and has no log streaming yet. Do not expose it through a reverse proxy until the proxy/TLS contract is reviewed.

## Getting started

Requirements: Bun 1.4.2+ (pin the version in CI), an existing stacks directory, an admin password hash, and the Docker CLI with Compose v2 for real state. Docker is optional: without it, stacks are listed with an `unknown` status rather than an invented one.

```sh
bun install
# Generate the admin password hash, then copy it into COMPOSE_PANEL_ADMIN_PASSWORD_HASH:
COMPOSE_PANEL_PASSWORD='change-me-please' bun run hash-password
STACKS_DIR=/opt/stacks COMPOSE_PANEL_ADMIN_PASSWORD_HASH='$argon2id$...' bun run dev
```

On PowerShell:

```powershell
bun install
$env:COMPOSE_PANEL_PASSWORD = 'change-me-please'
bun run hash-password
# Put the printed hash in COMPOSE_PANEL_ADMIN_PASSWORD_HASH
$env:STACKS_DIR = 'D:\stacks'
$env:COMPOSE_PANEL_ADMIN_PASSWORD_HASH = '$argon2id$...'
bun run dev
```

Open `http://127.0.0.1:5081` and log in. The stack names are listed and the Compose file can be viewed **read-only**. The starter intentionally rejects projects that require an explicit override file or several primary Compose files. The `.env` file is intentionally inaccessible in this slice. See [.env.example](.env.example) for every setting.

```sh
bun run test
bun run check
```

## What exists in this starter

- Framework-free Bun HTTP server, server-rendered HTML and a small local stylesheet.
- Single-admin authentication: Argon2id password hash, in-memory sessions with idle and absolute timeouts, rotation on login, HttpOnly/SameSite cookies.
- Per-session CSRF tokens and strict Origin/Referer checks on mutations; login rate limiting; bounded request bodies.
- Read-only Docker state: bounded `docker compose ls`/`ps` calls with explicit argument arrays, per-stack status derived from the real project (never the folder name), `unknown` when unresolved, and no secrets in errors. Project matching refuses ambiguity.
- Safe raw editing of `compose.yaml` and `.env`: no YAML round-trip, optimistic concurrency via content hashes, validation with `docker compose config --quiet` in the real project context, per-save backups with rollback, one operation per stack, and `.env` values redacted from errors.
- Predefined operations (`up`, `stop`, `restart`, `down`, `pull + up`) behind a fixed allow-list, one per stack, running in memory independently of the browser; success only on exit 0, timeout reported as unknown, bounded output, and a graceful drain on shutdown.
- Discovery of stacks whose directory contains **exactly one** of the supported Compose names.
- Name validation and rejection of symbolic links for reads and writes.
- Unit tests for path safety, HTML escaping, the auth/CSRF flows, Compose output parsing, the editor and the operation manager.
- `AGENTS.md`, ADRs, roadmap and agent missions ready to delegate.

## Implementation order

1. **Authentication and CSRF** before any network exposure or write. *(done, P1)*
2. **Reading the real Docker state** (without blindly inferring the project from the folder name). *(done, P2)*
3. **Editing** Compose and `.env` with optimistic versioning, validation in the real context, backup and controlled rollback. *(done, P3)*
4. **Predefined operations** with a per-stack lock and in-memory status (no automatic recovery). *(done, P4)*
5. **Logs** and SSE streaming independent of the operation's execution.
5. **Logs** and SSE streaming independent of the operation's execution.
6. **Reproducible Linux Dockerfile**, CI pipeline, restart test and deployment.

See [docs/roadmap.md](docs/roadmap.md), [AGENTS.md](AGENTS.md), [agents/](agents/) and [docs/security.md](docs/security.md).

## Structural decisions

Stacks remain directories with ordinary Compose files, and the container engine stays the source of truth for state. No interactive terminal, no remote agents, no graphical Compose generation, no arbitrary engine control. No SQLite until a real need for persistence is demonstrated. This V1 targets **a single instance on a single Linux host**.

The product is centered on the Compose specification, not on the Docker brand: engine-specific CLI calls sit behind a `ComposeProvider` boundary (ADR 0005). V1 targets Docker Compose only and does **not** claim Podman compatibility yet, but no structural choice blocks adding it later.

Compatibility with other panels relies on **mounting the same stacks directories**, not on migrating their databases. Never run two panels in write mode against the same files.

## Name and license

The project name is **Compose Panel**. Choose the license before any public release. No third-party panel code was copied into this starter.
