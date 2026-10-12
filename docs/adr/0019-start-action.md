# ADR 0019 — `Start` as a stack-wide operation

Status: accepted.

## Context
After a `Stop`, the only way to bring a stack's containers back was `Up`,
which can also recreate them from the Compose file and local images. Docker
Compose offers `start` for exactly this: start existing (stopped) containers
without creating or recreating anything.

## Decision
- Add `start` to the fixed operation allow-list (`up`, `pull`, `stop`,
  `restart`, `down`, `pull-up`, `start`). Stack-wide only in V1: no
  per-service selection (see ADR 0021).
- Provider call `start(target)` runs `compose start` through the existing
  `mutation()` helper: explicit `--project-directory` and `-f`, plus `-p`
  when the project is known. No user-supplied option.
- `start` never creates: an undeployed stack is refused like the other
  destructive actions (`creates` stays `up`/`pull-up`/`pull`). It requires a
  resolved project, like `stop`/`restart`/`down`.
- Same machinery as every operation: per-stack lock, detached run, success
  only on exit 0, SSE observation, CSRF/session/Origin, activity log
  (`operation` event with `action=start`).

## Not decided here
- Per-service start (with per-service restart/up, ADR 0021).
- `create` (`compose create`) without starting: no demonstrated need.

## Consequences
- The Actions card offers `Start` on deployed stacks (`running`/`stopped`),
  not on `not-created` and never on `unknown`.
- `Up` remains the only action that creates containers or applies file
  changes; its help text says so.
