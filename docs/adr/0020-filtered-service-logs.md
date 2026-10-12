# ADR 0020 — Logs filtered by service

Status: accepted.

## Context
The Logs card always showed every service with the configured tail. Daily
operation needs narrower views: one service, more or fewer lines. Compose
already filters (`logs [SERVICE]`, `--tail`), but the panel must never accept
a service string from the browser at face value.

## Decision
- **One reusable discovery call.** `ComposeProvider.listServices(target)`
  runs `compose --project-directory <dir> -f <file> config --services` in the
  same context as operations (explicit `-p` when known, verified `--env-file`
  when present). It returns the service names, or `null` when Compose fails,
  times out, truncates, or prints a name with unexpected syntax. `ps` is not
  a validation source: a defined service may have no container.
- **Validation on every read.** `GET /stacks/<name>/logs` and
  `.../logs/events` accept `?service=` and `?tail=`. A non-empty service must
  pass the service-name syntax check and belong exactly to the discovered
  list; otherwise `400` (bad syntax) or `409` (unknown service), with no
  `logs` subprocess spawned afterwards (the discovery call itself is
  expected). `tail` must be one of `100/200/500/1000`; anything else falls
  back to the configured `COMPOSE_PANEL_LOG_TAIL_LINES`, whose contract does
  not change.
- **Profiles are never activated implicitly.** The panel passes no
  `--profiles` flag and no profile variable: a service disabled by its
  profile cannot match the discovery list, and Compose fails closed if asked
  for it anyway.
- **Service names can never become options.** Validated names are passed
  after `--` in a fixed argument array, never through a shell.
- **Stream identity is `(stack, service, tailLines)`.** The `LogManager`
  shares a subprocess only between identical selections, keeps at most **two**
  live streams per stack (a third selection is `409`), and keeps the existing
  guarantees: kill on last reader, bounded buffer/timeout, no overlapping
  replacement after an unconfirmed termination, process-wide subscriber cap.
  A filter change in one tab stops only its own follow; the user re-follows.
- **No `--since`, no new log system.** Plain GET form (works without JS);
  vanilla JS reads the selects for refresh/follow.

## Not decided here
- Per-service operations (ADR 0021); this ADR's discovery call is reused
  there unchanged.
- Container-level logs keep their own tail allow-list (ADR 0014).

## Consequences
- One more short Docker read (`config --services`) per filtered log request,
  bounded like every read.
- The Logs card carries two selects (service, lines); the dropdown services
  come from the already-loaded stack detail (convenience only — the server
  re-validates against `config --services` on every request).
