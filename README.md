# Compose Panel

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-on-dark.svg">
  <img src="docs/assets/logo-on-light.svg" alt="Compose Panel" width="640">
</picture>

A small, self-hosted web panel for the Docker Compose stacks of **one Linux server**. Your Compose files on disk stay the source of truth and Docker stays in charge of the containers: everything the panel does, you can still do with the `docker compose` CLI.

> **Status: 0.1, for a single trusted administrator.** The panel listens on `127.0.0.1` only. Reach it remotely through an SSH tunnel (`ssh -L5081:127.0.0.1:5081 you@host`), never through a public port or a reverse proxy: that setup has not been reviewed yet.

## What it does

- **Lists your stacks**: each folder in the stacks directory that contains exactly one Compose file, with its real state as reported by Docker (`unknown` when Docker cannot tell, never a guess).
- **Edits `compose.yaml` and `.env` as raw text**: comments and formatting are kept. Every change is checked with `docker compose config` before anything is written, each save keeps a backup, and a file changed elsewhere in the meantime is detected instead of overwritten.
- **Runs a fixed set of actions**: Up, Pull + up, Restart, Stop and Down, one at a time per stack. An action keeps running if you close the page, and its output streams live.
- **Follows logs** live (`docker compose logs --follow`).
- **Works on a phone**, in light or dark mode, with server-rendered pages and a few lines of plain JavaScript.

It deliberately has no terminal, no file browser, no arbitrary Docker command, no database and no multi-user support. Stacks that use Compose override files are refused rather than half-managed.

## Security in short

One admin account (Argon2id password hash), in-memory sessions with idle and absolute timeouts, CSRF protection and strict origin checks on every change, rate-limited sign-in. Docker is always called with a fixed executable and explicit arguments, never through a shell. Symbolic links and path escapes are refused, and `.env` values never appear in logs or error messages. Details in [docs/security.md](docs/security.md).

Mounting the Docker socket gives the panel full control of the host's Docker: only run it for an administrator you would trust with `root`.

## Deploy

```sh
cp deploy/compose-panel.env.example deploy/compose-panel.env
# Set COMPOSE_PANEL_ADMIN_USER (a unique name) and COMPOSE_PANEL_ADMIN_PASSWORD_HASH:
COMPOSE_PANEL_PASSWORD='change-me-please' bun run hash-password
docker compose -f deploy/compose.yaml up -d --build
```

The stacks directory must be mounted at the same path inside and outside the container. Backups, rollback and the release checklist are in [docs/deployment.md](docs/deployment.md). Every setting is listed in [.env.example](.env.example).

## Develop

Requirements: Bun 1.4.3+, a stacks directory, and optionally the Docker CLI with Compose v2. Without Docker, stacks are simply listed as `unknown`.

```sh
bun install
COMPOSE_PANEL_PASSWORD='change-me-please' bun run hash-password
# COMPOSE_PANEL_DEV=true allows the default "admin" username, for local development only.
STACKS_DIR=/opt/stacks COMPOSE_PANEL_ADMIN_PASSWORD_HASH='$argon2id$...' COMPOSE_PANEL_DEV=true bun run dev
```

On PowerShell:

```powershell
bun install
$env:COMPOSE_PANEL_PASSWORD = 'change-me-please'
bun run hash-password
$env:STACKS_DIR = 'D:\stacks'
$env:COMPOSE_PANEL_ADMIN_PASSWORD_HASH = '$argon2id$...'
$env:COMPOSE_PANEL_DEV = 'true'
bun run dev
```

Then open `http://127.0.0.1:5081`.

```sh
bun run test       # unit and integration tests
bun run typecheck
bun run test:wsl   # on Windows: the same suite on Linux through WSL
```

`test:wsl` needs Bun in the default WSL distribution. It copies the working tree into the Linux file system so that the signal, symlink and file-mode tests actually run. Contributors and coding agents: read [AGENTS.md](AGENTS.md) first.

## Documentation

- [docs/product.md](docs/product.md): scope and non-goals
- [docs/architecture.md](docs/architecture.md) and [docs/adr/](docs/adr/): how it is built and why
- [docs/security.md](docs/security.md): threat model and invariants
- [docs/deployment.md](docs/deployment.md): deploying, backups, rollback, release checklist
- [docs/operations.md](docs/operations.md): adding Compose commands safely, switching over from another panel
- [docs/roadmap.md](docs/roadmap.md): what may come next
- [CHANGELOG.md](CHANGELOG.md): what changed

## License

Copyright 2026 LeKoala, licensed under the EUPL-1.2 (see [LICENSE](LICENSE)). No third-party panel code was copied into it.
