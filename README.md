# Compose Panel

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-on-dark.svg">
  <img src="docs/assets/logo-on-light.svg" alt="Compose Panel" width="640">
</picture>

A small, self-hosted web panel for the Docker Compose stacks of **one Linux server**. Your Compose files on disk stay the source of truth and Docker stays in charge of the containers: everything the panel does, you can still do with the `docker compose` CLI.

> **Status: 0.3.0, for a single trusted administrator.** The panel only ever listens on `127.0.0.1`, so a port mapping cannot expose it by mistake. Reach it through an SSH tunnel (`ssh -L5081:127.0.0.1:5081 you@host`), over HTTPS with Caddy on the same host, or both at once: `COMPOSE_PANEL_PROXY_ORIGINS` lists the allowed origins and `COMPOSE_PANEL_ALLOW_LOOPBACK=true` keeps the tunnel, see [docs/deployment.md](docs/deployment.md#behind-caddy-https).

## What it does

- **Lists your stacks**: each folder in the stacks directory that contains exactly one Compose file, with its real state as reported by Docker (`unknown` when Docker cannot tell, never a guess).
- **Edits `compose.yaml` and `.env` as raw text**: comments and formatting are kept. Every change is checked with `docker compose config` before anything is written, each save keeps a backup, and a file changed elsewhere in the meantime is detected instead of overwritten.
- **Runs a fixed set of actions**: Up, Pull + up, Restart, Start, Stop and Down, one at a time per stack — Restart and Up can also target a single service from the Services table. An action keeps running if you close the page, and its output streams live.
- **Follows logs** live (`docker compose logs --follow`), for the whole stack or one service, with a choice of line counts.
- **Shows Docker diagnostics** on a read-only **Server** page (`/server`): engine facts from `docker info`, per-container and per-stack CPU/memory from `docker stats`, a current-state "Needs attention" list, and Docker-managed disk usage read on demand. It uses only the Docker API: no host agent, no history, and the host view (load, memory, uptime, filesystems, system updates) is not covered.
- **Updates itself** from the **About** page when it runs from the official image: it downloads its own image tag and installs it only once its GitHub release is 72 hours old and the image matches the published digest. A short-lived updater container then recreates only the panel container, checks that it comes back healthy and keeps the previous image for a rollback. Your stacks keep running, and the result stays visible after the restart ([docs/deployment.md](docs/deployment.md#updating-from-the-browser)).
- **Works on a phone**, in light or dark mode, with server-rendered pages and a few lines of plain JavaScript.

It deliberately has no terminal, no file browser, no arbitrary Docker command, no database and no multi-user support. Stacks that use Compose override files are refused rather than half-managed.

## Security in short

One admin account (Argon2id password hash), in-memory sessions with idle and absolute timeouts, CSRF protection and strict origin checks on every change, rate-limited sign-in. Docker is always called with a fixed executable and explicit arguments, never through a shell. Symbolic links and path escapes are refused, and `.env` values never appear in logs or error messages. Details in [docs/security.md](docs/security.md).

Mounting the Docker socket gives the panel full control of the host's Docker: only run it for an administrator you would trust with `root`.

## Deploy

You need Docker Engine with Compose v2 and a stacks directory already managed by
`docker compose`. No Bun install is required on the host: the image provides it.

```sh
# 1. Clone and copy the env file
git clone https://github.com/lekoala/compose-panel.git
cd compose-panel
cp deploy/compose-panel.env.example deploy/compose-panel.env

# 2. Build (or pull) the image first, so step 3 can use it
docker compose -f deploy/compose.yaml build

# 3. Generate the admin password hash with the image itself (no Bun on the host)
read -rsp "Compose Panel password: " COMPOSE_PANEL_PASSWORD; echo
export COMPOSE_PANEL_PASSWORD
docker run --rm --entrypoint bun -e COMPOSE_PANEL_PASSWORD \
  compose-panel:local src/scripts/hash-password.ts
unset COMPOSE_PANEL_PASSWORD

# 4. Put the hash and a unique COMPOSE_PANEL_ADMIN_USER in
#    deploy/compose-panel.env. Keep the hash in single quotes: its "$" must
#    reach the panel literally (Compose interpolates unquoted env_file values).

# 5. Lock the file down and start
chmod 600 deploy/compose-panel.env
docker compose -f deploy/compose.yaml up -d
```

The stacks directory must be mounted at the same path inside and outside the
container. Backups, rollback and the release checklist are in
[docs/deployment.md](docs/deployment.md). Every setting is listed in
[.env.example](.env.example). If sign-in or a stack looks wrong, see
[docs/troubleshooting.md](docs/troubleshooting.md).

## Develop

To see the panel right away, without Docker or any setup:

```sh
bun install
bun run preview          # http://127.0.0.1:5081, sign in as admin / preview
```

The preview runs the real panel on demo stacks (in `.preview/`, git-ignored) with a **simulated** Docker: listing, editing and validation, actions with live output, logs and the activity log all work, and no Docker command ever runs. `bun run preview --reset` recreates the demo stacks.

To run it against your own stacks and the real Docker CLI, you need Bun 1.4.3+, a stacks directory, and optionally the Docker CLI with Compose v2. Without Docker, stacks are simply listed as `unknown`.

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
bun run test:proxy:wsl  # on Windows: end-to-end check behind a real Caddy (TLS)
bun run test:docker-lab:wsl  # on Windows: collisions and SIGTERM on a disposable Docker-in-Docker daemon
```

`test:wsl` needs Bun in the default WSL distribution. It copies the working tree into the Linux file system so that the signal, symlink and file-mode tests actually run. Contributors and coding agents: read [AGENTS.md](AGENTS.md) first.

## Documentation

The same pages are published as a static site at <https://lekoala.github.io/compose-panel/> (built with `bun run docs:build`, deployed by `.github/workflows/pages.yml`).

- [docs/product.md](docs/product.md): scope and non-goals
- [docs/architecture.md](docs/architecture.md) and [docs/adr/](docs/adr/): how it is built and why
- [docs/security.md](docs/security.md): threat model and invariants
- [docs/deployment.md](docs/deployment.md): deploying, backups, rollback, release checklist
- [docs/troubleshooting.md](docs/troubleshooting.md): sign-in, stacks, logs and other common issues
- [docs/migrating-from-dockge.md](docs/migrating-from-dockge.md): switching from Dockge, step by step
- [docs/operations.md](docs/operations.md): adding Compose commands safely, switching over from another panel
- [docs/roadmap.md](docs/roadmap.md): what may come next
- [CHANGELOG.md](CHANGELOG.md): what changed

## License

Copyright 2026 LeKoala, licensed under the EUPL-1.2 (see [LICENSE](LICENSE)). No third-party panel code was copied into it.
