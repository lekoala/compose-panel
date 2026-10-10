# CI — pipeline

The pipeline lives in `.github/workflows/ci.yml` (Linux runners, Bun 1.4.2
pinned): `bun install --frozen-lockfile`, `bun run check`, `bun run test`,
then a reproducible image build, a socket-less smoke test (reads and auth
only, no Docker socket mounted) and a Trivy scan that fails on CRITICAL.
PR builds never publish images.

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
