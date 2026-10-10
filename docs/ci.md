# CI — pipeline

The pipeline lives in `.github/workflows/ci.yml` (Linux runners, Bun 1.4.2
pinned): `bun install --frozen-lockfile`, `bun run check`, `bun run test`,
then a reproducible image build, a socket-less smoke test (reads and auth
only, no Docker socket mounted) and a Trivy scan that fails on CRITICAL.
PR builds never publish images.

`tests/process-linux.test.ts` runs automatically on Linux: disposable Bun
children exercise a real provider subprocess, split UTF-8, abort and timeout
escalation against a child ignoring `SIGTERM`, including a plugin-like child
inheriting the CLI parent's pipes and process group. The provider executable is a
clearly marked fixture; these tests never invoke Docker or access a daemon.
Browser fixtures verify that operation/log text fragments survive SSE insertion.

The test job also runs `tests/compose-config-linux.test.ts` with
`COMPOSE_PANEL_TEST_COMPOSE_CONFIG=1`: real `compose config` resolves project
names from the directory, YAML, `.env` and process environment. Project discovery
is stubbed and every real command is restricted to `config`; no daemon access or
resource mutation occurs. Run the same command manually on Linux with the
installed Compose CLI. The ordinary test suite skips this opt-in check.

## Disposable-daemon integration (opt-in)

The read-only Docker integration test (`tests/docker-integration.test.ts`)
runs only with `COMPOSE_PANEL_TEST_DOCKER=1`, on a disposable isolated daemon
with secret-free fixtures — never on a production socket, never in
unattended CI.

## Publication (tags only)

Releases are published by `.github/workflows/release.yml`, triggered only by
a maintainer tag (`v*`), after the smoke test and review: build the Linux
image with Bun + Docker CLI + Compose plugin (pinned, verified with
`bun --version`, `docker --version`, `docker compose version`), scan it, push
immutable version tags plus `latest` to GHCR.

## Deployment
Keep the build and deployment steps separate. Publishing an image must **never** automatically update production stacks.
