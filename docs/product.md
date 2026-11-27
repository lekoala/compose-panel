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
- Start, stop, restart, pull images on their own (for the whole stack or one service) or followed by an up (predefined, explicit actions), and see which services have an update ready, from which version to which, before applying it ([ADR 0011](adr/0011-pull-and-update-ready.md), [ADR 0041](adr/0041-targeted-pull-and-remote-image-check.md)). A manual **Check** reads each registry to tell whether a tag moved upstream before anything is downloaded; anything it cannot prove is shown as unknown with a reason, never as a verdict.
- Follow progress via SSE and review the real state after an interruption.
- View Compose logs, without an interactive console.
- Show read-only Docker diagnostics: engine facts, per-container and per-stack CPU/memory, and Docker-managed disk usage, with no history and no host agent ([ADR 0015](adr/0015-readonly-engine-insights.md)).
- Run a stack's declared, non-interactive application actions (Composer, npm or Bun scripts, or fixed commands) from a dedicated page, one at a time under the per-stack lock, with live bounded output and no arbitrary command ([ADR 0026](adr/0026-application-toolbox.md)).
- Run an opt-in rollout of one explicitly declared service: start a second instance, wait for it to become healthy, optionally drain the old one, then stop and remove only the old container, with conditional cleanup before drainage and an intervention after it ([ADR 0035](adr/0035-optional-service-rollout.md)).
- Prune old, unused Docker data from the Server page, manual only: fixed build-cache and image scopes with a one-week age floor, one run at a time under the global engine lock, authenticated and CSRF-protected, never volumes or containers, and no scheduler ([ADR 0040](adr/0040-docker-storage-maintenance.md)).
- Link a stack to an external database explorer (LibreDB Studio, Adminer, pgAdmin…) through a declarative `x-compose-panel.database` extension, without the panel contacting the explorer, holding a credential or opening a database ([ADR 0027](adr/0027-external-database-explorer-links.md)).
- Start from a curated Compose recipe for a complementary hosting service: a reviewed, version-pinned prefill of the existing **New stack** form, editable and owned by the operator afterwards, with no catalogue, provisioning engine or dedicated lifecycle ([ADR 0058](adr/0058-curated-compose-recipes.md)).
- Attach a public domain to a stack service through an optional host Caddy helper: one managed file per domain, published only after validation, with reload and honest rollback, and only to a loopback-bound upstream port ([ADR 0030](adr/0030-optional-caddy-sites.md)).
- Single-administrator authentication, CSRF, correct sessions and minimal audit logging without secrets.
- Update the panel itself from the browser, for the documented Docker deployment of the official image: pull its own image tag, install it only when its release and digest registration are at least 72 hours old and match the published digest, then recreate its container through an independent one-shot updater that keeps the previous image for rollback, with the outcome read back from Docker ([ADR 0018](adr/0018-self-update.md), [ADR 0028](adr/0028-versioned-release-registry.md)).

## Shape

Compose Panel is a Compose-first hosting panel: one server, one trusted
administrator, Compose files on disk and the Docker CLI as the sources of truth
([ADR 0056](adr/0056-compose-first-web-hosting.md)). Three layers share that
ground.

| Layer | Content | Status |
| --- | --- | --- |
| Compose applications | Stacks and services, raw configuration, logs and diagnostics, declared application actions, bounded rollout, optional Caddy domain attach | Core |
| Managed websites | PHP provisioning, Git releases, Composer preparation, deploy and rollback, existing database attachment, offsite backup and verified restore | Optional, opt-in, off by default |
| Shared maintenance | Image checks, bounded grouped updates, read-only Docker diagnostics | Crosses both layers |

An item belongs to *shared maintenance* when it acts on the same facts for a
hand-written stack and for a managed site. Grouped updates are the current
example: they concern any service on any stack, not only a managed site.

## Accepted scope extensions

Each extension below is in scope, bounded by its own ADR, and none of them
widens the access model: one administrator, loopback binding, no database, no
scheduler.

- A bounded, opt-in rollout of one declared service, which is not a general
  orchestrator ([ADR 0035](adr/0035-optional-service-rollout.md)).
- A declared, non-interactive application action toolbox built from each
  project's own Composer/npm/Bun scripts, not a terminal and not generic
  command execution ([ADR 0026](adr/0026-application-toolbox.md)).
- A declarative external link to a database explorer: a URL built from trusted
  configuration, never a SQL client or a credential store
  ([ADR 0027](adr/0027-external-database-explorer-links.md)).
- The managed-site pilot: one versioned manifest opts a hand-written stack into
  one bind-mount release layout, or generates the one fixed PHP profile
  ([ADR 0042](adr/0042-managed-site-ownership.md)). The creation form, preview,
  deterministic generated files, reserved loopback port, drift refusal and
  explicit regeneration are part of it; the first release is an explicit
  baseline action, not a deployment.
- Manual Git deployment for those bind-mount stacks only: immutable releases, an
  atomic pointer switch, a verified serving revision and a probed code rollback,
  with no scheduler, webhook, image build or migration
  ([ADR 0043](adr/0043-bounded-git-release-lifecycle.md)).
- The fixed disposable Composer preparation; npm, asset pipelines and arbitrary
  scripts stay out ([ADR 0045](adr/0045-disposable-composer-preparation.md)).
- An existing database attachment: one operator-provisioned database per site,
  one declared external network joined only by the runtime service, and an
  operator-owned env file; the panel never connects, runs SQL or stores a
  credential ([ADR 0048](adr/0048-existing-database-attachment.md)). The site
  manifest may also declare the same explorer link as an ordinary stack, with no
  generated-file change ([ADR 0059](adr/0059-managed-site-database-explorer-link.md)).
- A manual offsite backup and a verified restore into isolation: declared
  persistent roots and one optional dump, fixed private credentials, pinned
  one-shot tooling and an accepted snapshot id; no deletion, no scheduler and no
  stored credential value ([ADR 0049](adr/0049-offsite-backup-and-restore.md)).
- Site-scoped machine triggers for deploy and backup: a digest-only verifier, a
  bounded request window and a consumed nonce; the panel runs no timer
  ([ADR 0050](adr/0050-ci-triggered-deploy.md),
  [ADR 0051](adr/0051-timer-triggered-backups.md)).
- Read-only retention preview, snapshot inventory and repository check: they
  measure and report, and never delete, repair or unlock
  ([ADR 0052](adr/0052-retention-preview.md),
  [ADR 0053](adr/0053-read-only-snapshot-inventory.md),
  [ADR 0054](adr/0054-read-only-repository-check.md)).

Managed-site Git sources can use public HTTPS or private SSH with a
repository-scoped read-only key and an independently pinned host key
([ADR 0047](adr/0047-private-git-over-ssh.md)).

## Explicitly not planned

Each item is refused for a stated reason and can be reopened by a new ADR that
names a concrete need ([ADR 0056](adr/0056-compose-first-web-hosting.md)). "Not
planned" is a decision about the current product, not a permanent prohibition.

- Podman provider, per-stack network options, volume/network/image management
  UI, registry UI, CVE scanning, automatic update policies, panel-managed
  scheduling.
- Multi-user, roles, public API, notifications, alerts, monitoring with retained
  history.
- Host toolbox and operating-system administration: package transactions, reboot
  orchestration, firewall, users, package repositories, distribution upgrades.
- Agents, remote control, terminal / PTY, general-purpose file manager,
  graphical Compose editor, an application catalogue or app store, remote
  recipe registry, encrypted secrets editor, plugins, Kubernetes. Curated
  Compose recipes are admitted in one narrow form only: a reviewed prefill of
  the existing creation form, with no provisioning engine or lifecycle
  ([ADR 0058](adr/0058-curated-compose-recipes.md)).
- A second panel or agent reconciling the same stacks: one mutator per stack.

Host visibility is admitted in one form only: if a concrete hosting need appears
(filesystem pressure, reboot required, memory saturation), a bounded read-only
collector may report it. Administering the operating system stays outside the
product.

Deferred to their own ADR, and therefore not refused: live promotion of a
restored snapshot, retention automation with a separate deletion credential,
production cutover and cloning, a second runtime profile, support for Compose
override files, and a machine trigger for the rollout of an ordinary stack.

## Assumed non-goals
- No guaranteed operation outcome after a panel crash: the outcome may be unknown.
- No orchestrator: container restart policies belong to Docker. A bounded,
  opt-in rollout of one declared service is the explicit exception
  ([ADR 0035](adr/0035-optional-service-rollout.md)); it is not a general
  deployment engine.
- No automatic resumption of interrupted `pull`/`up` commands.
- No API or protocol compatibility with other panels.
