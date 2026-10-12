# Product

## Problem
Administer a small number of Docker Compose stacks on **a single host**, from the browser, without heavy tooling and without locking data into a proprietary database.

## Personas
A trusted technical administrator. No multi-tenancy, no access for untrusted users. Mounting the Docker socket is equivalent to granting very high privileges on the host.

## V1 (acceptance criteria)
- Create a named stack directory from raw Compose and optional `.env`, validating before publication without deployment ([ADR 0024](adr/0024-controlled-stack-creation.md)).
- Read-only deployed image metadata per container and separately declared Compose labels ([ADR 0023](adr/0023-deployment-metadata.md)).
- Display valid Compose directories and the **real** state of projects/services.
- Read/edit the raw Compose file and `.env`, without automatic rewriting of comments.
- Validate a change against the effective directory, files and project identity.
- Save with concurrent-change detection and the ability to return to the previous state.
- Start, stop, restart, pull images on their own or followed by an up (predefined, explicit actions), and see which services have an update ready, from which version to which, before applying it ([ADR 0011](adr/0011-pull-and-update-ready.md)).
- Follow progress via SSE and review the real state after an interruption.
- View Compose logs, without an interactive console.
- Show read-only Docker diagnostics: engine facts, per-container and per-stack CPU/memory, and Docker-managed disk usage, with no history and no host agent ([ADR 0015](adr/0015-readonly-engine-insights.md)).
- Run a stack's declared, non-interactive application actions (Composer, npm or Bun scripts) from a dedicated page, one at a time under the per-stack lock, with live bounded output and no arbitrary command ([ADR 0026](adr/0026-application-toolbox.md)).
- Link a stack to an external database explorer (LibreDB Studio, Adminer, pgAdmin…) through a declarative `x-compose-panel.database` extension, without the panel contacting the explorer, holding a credential or opening a database ([ADR 0027](adr/0027-external-database-explorer-links.md)).
- Single-administrator authentication, CSRF, correct sessions and minimal audit logging without secrets.
- Update the panel itself from the browser, for the documented Docker deployment of the official image: pull its own image tag, install it only when its release is at least 72 hours old and matches the published digest, then recreate its container through an independent one-shot updater that keeps the previous image for rollback, with the outcome read back from Docker ([ADR 0018](adr/0018-self-update.md)).

## Out of scope (do not implement without an ADR)
Agents, remote control, terminal / PTY, graphical Compose editor, generated templates/catalogues, general-purpose file manager, Restic backups, encrypted secrets editor, scheduler, public API, multi-user, monitoring with retained history or alerts, registry UI, plugins, Kubernetes, notifications. Raw single-directory stack creation is in scope (ADR 0024); broader file generation remains out of scope. A read-only resource snapshot is now in scope (ADR 0015); a time-series dashboard, alerting and host-level health remain out of scope until a new ADR. A declared, non-interactive **application** action toolbox is in scope ([ADR 0026](adr/0026-application-toolbox.md)), built from each project's own Composer/npm/Bun scripts: it is not the terminal or generic command execution that stays out of scope, and a host toolbox stays out of scope until a new ADR. A **declarative external link** to a database explorer is in scope ([ADR 0027](adr/0027-external-database-explorer-links.md)): the panel builds a URL from trusted configuration only, and never becomes a SQL client, a database proxy or a credential store.

## Assumed non-goals
- No guaranteed operation outcome after a panel crash: the outcome may be unknown.
- No orchestrator: container restart policies belong to Docker.
- No automatic resumption of interrupted `pull`/`up` commands.
- No API or protocol compatibility with other panels.
