# ADR 0056 - Compose-first web hosting

Status: accepted (2026-11-27). Documentation only: this ADR changes no runtime
behavior, no endpoint, no file format and no guarantee.

## Context

- [ADR 0001](0001-product-shape.md) defined a small Compose panel for one host
  and one trusted administrator. V1 in [product.md](../product.md) covers
  stack administration: create, edit, validate, pull, up, logs, declared
  application actions, an opt-in rollout, Caddy site management and read-only
  Docker diagnostics.
- Since [ADR 0042](0042-managed-site-ownership.md), a second layer exists:
  managed websites, with immutable Git releases, a verified serving revision, a
  probed rollback, Composer preparation, an attached existing database, an
  offsite backup with a verified restore, and site-scoped machine triggers
  ([ADR 0043](0043-bounded-git-release-lifecycle.md),
  [ADR 0045](0045-disposable-composer-preparation.md),
  [ADR 0047](0047-private-git-over-ssh.md),
  [ADR 0048](0048-existing-database-attachment.md),
  [ADR 0049](0049-offsite-backup-and-restore.md),
  [ADR 0050](0050-ci-triggered-deploy.md),
  [ADR 0051](0051-timer-triggered-backups.md),
  [ADR 0052](0052-retention-preview.md),
  [ADR 0053](0053-read-only-snapshot-inventory.md),
  [ADR 0054](0054-read-only-repository-check.md)).
- The roadmap still listed general Docker-management work: a Podman provider,
  per-stack network options, read-only host insights, targeted host maintenance
  and a host toolbox. Larger projects (Portainer, Dockge, Arcane, RunCloud)
  already own most of that ground, and no hosting need in this project requires
  it.
- The recorded operational need is narrower: run a few Compose applications
  whose lifecycle genuinely belongs to Docker, host conventional PHP sites that
  do not justify one container lifecycle each, and apply one image update (a PHP
  CVE, for example) in one place across the sites that share that image.
- Because both layers were described in the same flat lists, a reader could not
  tell what is core, what is optional, and what is refused. The risk is scope
  drift, not a missing feature.

## Decision

### Positioning

Compose Panel is a lightweight, single-server hosting panel built around Docker
Compose. It manages existing Compose applications and provides an optional,
opinionated hosting workflow for conventional websites.

Compose files on disk and the Docker CLI remain the sources of truth: every
panel action is still reproducible with `docker compose` alone.

### Three layers

| Layer | Content | Status |
| --- | --- | --- |
| **Compose applications** | Stacks and services, raw configuration, logs and diagnostics, declared application actions, bounded rollout, domain attach through Caddy ([ADR 0030](0030-optional-caddy-sites.md)) | Core |
| **Managed websites** | PHP provisioning, Git releases, Composer preparation, deploy and rollback, existing database attachment, offsite backup and verified restore | Optional, opt-in, off by default |
| **Shared maintenance** | Image checks, bounded grouped updates, read-only Docker diagnostics | Crosses both layers |

An item belongs to *shared maintenance* when it acts on the same facts for a
hand-written stack and for a managed site. Grouped updates are the current
example: they apply to any service on any stack, not only to managed sites.

### Explicitly not planned

Each item below is refused for a stated reason and can be reopened by a new ADR
that names a concrete need. "Not planned" is a decision about the current
product, not a permanent prohibition.

- Podman provider, per-stack network options, volume/network/image management
  UI, registry UI, CVE scanning, automatic update policies, panel-managed
  scheduling.
- Multi-user, roles, public API, notifications, alerts, monitoring with retained
  history.
- Host toolbox and operating-system administration: package transactions,
  reboot orchestration, firewall, users, package repositories, distribution
  upgrades.
- Agents, remote control, terminal / PTY, general-purpose file manager,
  graphical Compose editor, templates and catalogues, plugins, Kubernetes. A
  curated recipe as a reviewed prefill of the existing creation form is not a
  catalogue and is admitted by [ADR 0058](0058-curated-compose-recipes.md).
- A second panel or agent reconciling the same stacks.

Host visibility stays admissible in one form only: if a concrete hosting need
appears (filesystem pressure, reboot required, memory saturation), a bounded
read-only collector may report it. Administering the operating system remains
outside the product.

### One mutator per stack

Two tools must not reconcile the same Compose directory. The panel is the only
mutating owner of the stacks directory it serves; another panel may coexist only
on a separate set of directories. The `stack.managed-by` label stays
informational ([ADR 0025](0025-declared-deployment-owner.md)).

### Runtime contract

The runtime is independent of the application code and can be updated across
sites. That is the invariant: not "the runtime is always an official image".

- The code lives in an immutable Git release; the runtime lives in an image
  reference shared by tag. A release rollback is not a PHP rollback, and the
  reverse is also true.
- Managed sites currently use two pinned official channels
  (`php:8.3-fpm-alpine`, `php:8.4-fpm-alpine`). A common image maintained by the
  operator (`ghcr.io/<owner>/php-runtime:8.4`) is admissible later as a new
  channel, provided it is rebuilt and published when its base image receives a
  fix, and added through its own ADR.
- Pinning a digest remains possible for an operator who prefers it, at the known
  cost of leaving the tag-based update check ([ADR 0041](0041-targeted-pull-and-remote-image-check.md)).

### External design references

Reading another panel's interface to improve ours is allowed. Importing its
scope is not. An improvement is admissible if it simplifies an existing
workflow, improves reliability, comprehension or accessibility of an operation,
or answers a concrete hosting need. Competitive parity is never a sufficient
justification.

### Pilot gate

The managed-site pilot stays off by default until the real-host checklist in
[deployment.md](../deployment.md#remaining-real-host-validation) is run and
recorded. No new managed-site feature is added before that record exists.

## Consequences

- [product.md](../product.md) carries the three layers and the not-planned list
  instead of one undifferentiated out-of-scope paragraph.
- [roadmap.md](../roadmap.md) leads with the pilot gate, and moves the Podman
  provider and per-stack network options to *explicitly not planned*.
- The README describes the core layer, the optional managed-site layer and the
  shared maintenance items separately.
- No privilege, process, dependency, credential, stored state or endpoint is
  added. All existing guarantees (loopback binding, single administrator, no
  operation database, no scheduler, one modifying operation per stack) stand.
- The one admitted functional gap against larger panels is the absence of a
  cross-stack update view and a bounded grouped update. It is tracked
  separately and changes the operation contract, so it needs its own ADR
  (0057).
- Reopening an item requires a concrete need and a new ADR. The purpose of this
  ADR is to prevent silent drift, not to freeze the product for later years.

## Alternatives rejected

- **Adopt a larger panel (Arcane, Portainer) for the Docker side.** It would
  duplicate a hosting workflow this project already owns, introduce a second
  reconciler on the same stacks, and replace one bounded missing feature with a
  platform and its credentials, database and multi-user model.
- **Keep the general Docker-management scope.** It serves no recorded hosting
  need, is permanently behind dedicated projects, and dilutes an auditable
  surface that is the actual differentiator.
- **Pool one PHP-FPM runtime across sites.** It couples the blast radius of a
  runtime update across all sites and is unnecessary while one tag is shared and
  a bounded batch can recreate the affected services one stack at a time.
- **Require an operator-maintained PHP image.** Rejected as a default, not as a
  possibility: the official channels stay until a concrete extension or
  configuration need justifies a common image.
