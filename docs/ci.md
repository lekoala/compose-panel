# CI — bootstrap pipeline

Do not ship an invented YAML buildspec: configure the CI job according to the available Linux runners, then version a buildspec validated by the instance (CI schemas evolve).

## Step A — Quality without Docker
1. Run on a **Linux** runner with an explicitly pinned Bun version.
2. Run `bun install --frozen-lockfile` (the first local `bun install` must generate `bun.lock`, to be committed).
3. Run `bun run test` then `bun run check`.
4. Do not publish an OCI image if these commands fail.

## Step B — Compose integration (once the runner exists)
1. Provide a **disposable, isolated** Docker daemon, never the CI host's production socket.
2. Provision Compose fixtures without secrets and without external network access by default.
3. Verify `config`, discovery, statuses, edit/save, operation locking, SSE disconnect and Bun shutdown during a process.
4. Destroy the test daemon and volumes at the end, even on failure.

## Step C — Publication (P6 only)
1. Build the Linux image with Bun + Docker CLI + Compose plugin and their pinned versions.
2. Verify the binaries actually present with `bun --version`, `docker --version`, `docker compose version`.
3. Scan dependencies and the image, include immutable tags and digests.
4. Publish only on a maintainer tag, after a smoke test and review.

## Deployment
Keep the build and deployment steps separate. Publishing an image must **never** automatically update production stacks.
