# ADR 0008 — Compose subprocess environment

Status: accepted.

## Decision
- Docker/Compose subprocesses receive the process environment **minus the
  `COMPOSE_PANEL_*` namespace**. `composeEnvironment()` in `src/docker.ts` builds
  this copy; every spawn (reads, mutations, log follows) uses it.
- Panel-only variables — most importantly `COMPOSE_PANEL_ADMIN_PASSWORD_HASH` —
  can therefore never enter Compose interpolation, even if a stack's
  `compose.yaml` references `${COMPOSE_PANEL_ADMIN_PASSWORD_HASH}`.
- All other inherited variables pass through unchanged. This deliberately keeps
  operator-controlled Compose inputs such as `COMPOSE_PROJECT_NAME`,
  `DOCKER_HOST`, registries and credential variables, whose precedence over
  `.env` is part of the Compose contract and is documented in
  `docs/deployment.md`.
- The panel's own settings stay inside the `COMPOSE_PANEL_*` namespace. A
  non-namespaced variable the panel reads for itself (for example `PORT`) is a
  shared name and is documented as such; operators should not assume it is
  hidden from Compose.

## Why
Handing the whole environment to Compose means panel credentials and unrelated
process secrets are interpolatable by the very files the panel lets an
administrator edit. That is a real, if narrow, disclosure path (the single-admin
threat model already grants very high authority, but the boundary was
inconsistent). Stripping one namespace removes the panel's own secrets at no
cost to legitimate Compose configuration.

A stricter allow-list (only `PATH`/`HOME`/`DOCKER_*`/`COMPOSE_*`) was rejected:
it would silently break documented operator workflows and registry credentials,
and it is a larger behavioral change than the defect warrants. If a stronger
isolation is later required, it should be its own ADR with an explicit
allow-list and migration notes.

## Consequences
- `COMPOSE_PANEL_*` variables are unavailable to stacks by design. A stack that
  legitimately needs a value must define it in its own `.env` or environment.
- The regression test asserts that a `COMPOSE_PANEL_*` variable is absent from
  the subprocess environment while another variable is preserved.
- The deployment env file (`deploy/compose-panel.env`) keeps using the
  namespace, so no operator change is required.
- This narrows H2 of the security audit. Other process variables still reach
  Compose by design; the residual exposure is documented, not eliminated.
