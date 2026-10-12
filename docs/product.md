# Product

## Problem
Administer a small number of Docker Compose stacks on **a single host**, from the browser, without heavy tooling and without locking data into a proprietary database.

## Personas
A trusted technical administrator. No multi-tenancy, no access for untrusted users. Mounting the Docker socket is equivalent to granting very high privileges on the host.

## V1 (acceptance criteria)
- Display valid Compose directories and the **real** state of projects/services.
- Read/edit the raw Compose file and `.env`, without automatic rewriting of comments.
- Validate a change against the effective directory, files and project identity.
- Save with concurrent-change detection and the ability to return to the previous state.
- Start, stop, restart, pull images on their own or followed by an up (predefined, explicit actions), and see which services have an update ready, from which version to which, before applying it ([ADR 0011](adr/0011-pull-and-update-ready.md)).
- Follow progress via SSE and review the real state after an interruption.
- View Compose logs, without an interactive console.
- Show read-only Docker diagnostics: engine facts, per-container and per-stack CPU/memory, and Docker-managed disk usage, with no history and no host agent ([ADR 0015](adr/0015-readonly-engine-insights.md)).
- Single-administrator authentication, CSRF, correct sessions and minimal audit logging without secrets.
- Update the panel itself from the browser, for the documented Docker deployment: pull its own image tag, then recreate its container through an independent one-shot updater, with the outcome read back from Docker ([ADR 0018](adr/0018-self-update.md)).

## Out of scope (do not implement without an ADR)
Agents, remote control, terminal / PTY, graphical Compose editor, file generation, general-purpose file manager, Restic backups, encrypted secrets editor, scheduler, public API, multi-user, monitoring with retained history or alerts, registry UI, plugins, Kubernetes, notifications. A read-only resource snapshot is now in scope (ADR 0015); a time-series dashboard, alerting and host-level health remain out of scope until a new ADR.

## Assumed non-goals
- No guaranteed operation outcome after a panel crash: the outcome may be unknown.
- No orchestrator: container restart policies belong to Docker.
- No automatic resumption of interrupted `pull`/`up` commands.
- No API or protocol compatibility with other panels.
