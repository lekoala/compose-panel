# ADR 0021 — Restart and Up scoped to one service

Status: accepted.

## Context
Restarting or updating a single service (`web`) without touching `db` is a
daily need. Compose offers both, with different semantics that the panel must
not blur: `restart` only restarts, while `up` recreates from the Compose file
and images. Service discovery (`listServices`, ADR 0020) is reused unchanged.

## Decision
- **Form, not new actions.** `POST /stacks/<name>/operations` accepts an
  optional `service` field next to `action`. `action=restart&service=web`
  and `action=up&service=web` are the only scoped combinations:
  - `restart` runs `compose restart --no-deps -- <service>` (`--no-deps` so
    dependents are not restarted; without it the "only this service" promise
    would be false).
  - `up` runs `compose up -d --no-deps -- <service>`: normal `Up` semantics
    (Compose may pull or build per its policy — no "local images only"
    promise), limited to the service, without starting its dependencies.
- **Creation rules (server-enforced, not UI-only).**
  - `up` without service may create the stack (unchanged).
  - `up` with service requires a deployed stack: `absent` is refused, it
    never creates.
  - `restart` with or without service requires a deployed stack (unchanged).
  - A `service` field on `down`, `pull`, `start` or `pull-up` is **refused**
    (`400`), never silently ignored.
- **Validation, same as logs (ADR 0020).** Syntax check, then exact
  membership in `listServices`; `400` / `503` / `409` before any mutation
  subprocess is spawned (the discovery call itself is expected). Names pass
  after `--` in a fixed argument array, never through a shell. No
  `--profiles` flag is ever passed.
- **Visibility.** `OperationView` and the activity log carry the service, so
  the UI and the audit trail read "Restart · web", not bare "Restart".
- **Locking.** One operation per stack, scoped or not: a service action
  holds the same per-stack lock and project reservation as a stack action.
- **UI.** The Services table offers per-service Restart/Up forms (plain
  POST, no JavaScript required); the Actions card stays stack-wide. Scoped
  buttons follow the same state table as stack actions (nothing on
  `unknown`).

## Not decided here
- Scoped `stop`/`start`/log tail per service beyond ADR 0020, `build + up`,
  exec presets (v0.4).
- `restart --no-deps` and `--` separator support depend on the embedded
  Compose: verified against it in the lab suite, not assumed.

## Consequences
- Provider `up`/`restart` read `target.service`; other mutations never
  receive one (the handler refuses it first).
- The lab suite covers the exact argument arrays against real Compose,
  including that `--no-deps` leaves dependents alone.
