# Compose Panel

A **single-server** panel to administer Docker Compose stacks, without a SPA, without an ORM and without a parallel orchestrator. The goal is a small, self-hosted tool that keeps Compose files as the source of truth.

> **Current state: authenticated read-only prototype, NOT production-ready.** A single administrator logs in; sessions, CSRF and login throttling are in place. It still listens on **`127.0.0.1` only** and no mutating Docker action is implemented. Do not expose it through a reverse proxy until the proxy/TLS contract is reviewed.

## Getting started

Requirements: Bun 1.4.2+ (pin the version in CI), an existing stacks directory, and an admin password hash. Docker is **not** required for this read-only slice.

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
- Discovery of stacks whose directory contains **exactly one** of the supported Compose names.
- Name validation and rejection of symbolic links for reads.
- No Docker call at this stage: we avoid displaying invented statuses.
- Unit tests for path safety, HTML escaping and the auth/CSRF flows.
- `AGENTS.md`, ADRs, roadmap and agent missions ready to delegate.

## Implementation order

1. **Authentication and CSRF** before any network exposure or write. *(done, P1)*
2. **Reading the real Docker state** (without blindly inferring the project from the folder name).
3. **Editing** Compose and `.env` with optimistic versioning, validation in the real context, backup and controlled rollback.
4. **Predefined operations** with a per-stack lock and in-memory status (no automatic recovery).
5. **Logs** and SSE streaming independent of the operation's execution.
6. **Reproducible Linux Dockerfile**, CI pipeline, restart test and deployment.

See [docs/roadmap.md](docs/roadmap.md), [AGENTS.md](AGENTS.md), [agents/](agents/) and [docs/security.md](docs/security.md).

## Structural decisions

Stacks remain directories with ordinary Compose files, and Docker stays the source of truth for containers. No interactive terminal, no remote agents, no graphical Compose generation, no arbitrary Docker control. No SQLite until a real need for persistence is demonstrated. This V1 targets **a single instance on a single Linux host**.

Compatibility with other panels relies on **mounting the same stacks directories**, not on migrating their databases. Never run two panels in write mode against the same files.

## Name and license

The project name is **Compose Panel**. Choose the license before any public release. No third-party panel code was copied into this starter.
