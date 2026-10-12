# ADR 0022 — `pull` downloads non-buildable services only

Status: accepted.

## Context
`Pull` ran a plain `docker compose pull`. For a stack with locally built
services, Compose tries to download an image that must be built instead, so
the action fails (or fetches the wrong thing) where it should succeed.
Compose offers `--ignore-buildable` for exactly this policy.

## Decision
- Provider `pull(target)` runs `compose pull --ignore-buildable` (same
  explicit project/directory/file context as before). `Pull + up` reuses
  `pull()`, so the policy covers both.
- Contract, stated in the UI and the changelog: **Pull downloads the images
  of services that are not built locally.** A service with a `build:` section
  is skipped — including one that *also* declares `image:` (Compose treats
  it as buildable). Those services are (re)built by `Up`/`Build + up`, never
  by `Pull`.
- No new parameter, no per-stack opt-out in V1: the old behavior (trying to
  download buildable images) was never useful, only surprising.

## Not decided here
- `Build + up` (v0.4): the counterpart that rebuilds local images.
- Pulling a buildable service's registry image on purpose: use the host CLI.

## Consequences
- A stack mixing registry and local images pulls cleanly in one step; the
  "Update ready" detection (ADR 0011) is unchanged — it already compares
  local images.
- Verified in the lab suite with a fixture combining `image:`-only,
  `build:`-only and `image:` + `build:` services.
