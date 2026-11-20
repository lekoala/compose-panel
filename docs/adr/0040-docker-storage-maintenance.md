# ADR 0040 — Targeted Docker storage maintenance

Status: accepted (2026-11-20).

## Context

Docker-managed storage grows without bound on a host that republishes images:
old images and build cache accumulate with no owner. The panel is
stack-scoped, and a scheduler is out of scope, but the administrator still
needs a deliberate way to reclaim that space — not a generic command runner.

## Decision

Offer manual storage maintenance on the Server page, always available to the
authenticated administrator.

It exposes three fixed scopes — build cache, dangling images, unused images —
each limited to data older than a week and built entirely on the server: the
browser only names one scope. Runs require an active session, an allowed Origin,
CSRF and an explicit confirmation.

Only one run happens at a time, and it excludes every stack mutation (saves,
operations, app actions, rollouts) as well as a panel self-update. The command
runs server-side, survives a closed tab, is bounded by a timeout and an output
cap, and is never replayed; its outcome is shown on the next page load. A
timeout or an exit Docker did not confirm is unknown, never success.

Volumes, containers and networks are never removed, and `docker system prune`
is not offered. The panel only acts on the daemon its socket reaches, never on
a separate runner or a Docker-in-Docker daemon.

The interface states what is not preserved: unused images include tagged
ones, so a future deployment, recreation or rollback may need a download or a
rebuild — including the panel's own rollback image. Stopped containers keep
their images. Reclaimed size is best effort, never a claim of zero.

Nothing is scheduled: recurring cleanup stays a host timer, outside the panel
and outside its guarantees.

## Consequences

- The panel gains its first engine-wide mutation; it is fixed and bounded by a
  one-week age floor, so recent images are kept as a rollback window.
- A long prune is unaffected by a browser or proxy disconnect: only the panel
  process matters.
- Docker applies its own notion of image age, so a recently pulled older image
  can be kept longer than expected — slower reclaim, but never overreach.
- Different filters, volume cleanup and `system prune` remain host work.

## Verification and rollback

Unit and route tests cover the fixed scopes, refusals, single-flight and the
lock rules; the destructive path is checked on an isolated disposable daemon,
never on a working host. Rollback removes the route, card and module; there is
no data migration and no Docker resource is changed by reverting.
