# Architecture

```text
Browser (HTML + minimal JS)
    | GET/POST + EventSource
Bun.serve (1 process, single instance)
    |-- Auth/session/CSRF
    |-- Stack files (read + safe edit)
    |-- Operation manager (in-memory Map, per-stack lock)
    |-- SSE observers / logs (bounded streams)
    |-- Audit log (append-only NDJSON files, bounded)
    |-- ComposeProvider (listProjects · projectServices · validateConfig)
    |     `-- Bun.spawn([docker, "compose", ...], explicit cwd, no shell)
    `-- ContainerInspector (list · inspect · logs · info · stats · diskUsage, read-only)
          `-- Bun.spawn([docker, "container", ...], explicit args, no shell)
                |-- directories /opt/stacks/<name>/compose.yaml + .env
                `-- Container Engine (source of truth for state)
```

## Container inspection (read-only)
Lower-level Docker calls that are not Compose operations live behind a second
boundary, `src/containers.ts`, built on the same fixed runner (`src/docker.ts`).
It exposes `list` (`docker container ls`, one structured line per container),
`inspect` and `logs`, all with fixed argument arrays and no shell. Container
listing and classification are pure and unit-tested in `src/container-state.ts`
(the `src/container-status.ts` loader joins discovery and the inspector). The
panel exposes no start/stop/remove/exec: the read-only guarantee is
application-level, not enforced by the socket mount. See
[ADR 0014](adr/0014-docker-container-inspection.md). The application toolbox
adds a separate `ActionRunner` boundary (`src/action-runner.ts`) for
`docker cp`/`docker exec`; this boundary stays read-only ([ADR 0026](adr/0026-application-toolbox.md)).

The container detail projection includes attached network names, IPv4 addresses
and DNS names (`DNSNames`, else `Aliases`), using the existing inspect response
and no additional Docker call ([ADR 0037](adr/0037-container-networks.md)). It
does not infer connectivity or DNS resolution from membership.

## Engine and resource insights (read-only)
`GET /server` renders Docker's own diagnostics: engine facts (`docker info`,
projected onto a fixed field whitelist), per-container and per-stack resource
usage (`docker stats --no-stream`) and, on demand only, Docker-managed storage
(`docker system df`, served through a short in-memory TTL cache). The calls live
on the `ContainerInspector` boundary and the pure parsing/aggregation is in
`src/insights.ts`. A collection that fails yields `null` for that section and a
note, never a fabricated zero. Stack usage reuses the ADR 0014 classification,
and a stack's CPU is a cumulative figure that may exceed 100 %. Host-level health
(load, memory, uptime, filesystems, package updates) is out of scope and would
need a separate host component and its own ADR. See
[ADR 0015](adr/0015-readonly-engine-insights.md). The Live refresh reuses the
same view functions for its rows and is bounded to the dynamic zones
([ADR 0044](adr/0044-one-renderer-per-live-region.md)).

## Web layer and live regions
The HTML is server-rendered in `src/html.ts`, with each feature moving to
`src/features/<feature>/views.ts` as it is touched (`src/features/server/` first)
and shared formatting in `src/web/`. `src/app.ts` keeps the single `fetch`
dispatcher and its guard order — Host, static assets, session, routes — because
every mutation depends on that one choke point. Routers (Hono, h3 or
`Bun.serve({ routes })`) stay deferred until route declaration or per-route
guarding becomes a recurring difficulty.

A dynamic region has exactly one renderer. The Server stats, stacks, attention
and exited tables are produced by the same functions on the first load and by
`GET /server/stats`; the endpoint returns the escaped row fragments and the
browser assigns them to the existing `<tbody>`. A null fragment means the
section could not be collected: the browser keeps the last good rows and still
updates the counters it could read, without moving the measurement time. A
partial collection is announced, so a repeated failure cannot present old CPU
and memory values as fresh. The endpoint answers `401` without a session
instead of redirecting, so a sign-in page can never enter a fragment, and the
memory total displayed by the page is echoed back to size the decorative stack
bars because the refresh never calls `docker info`. See
[ADR 0044](adr/0044-one-renderer-per-live-region.md).

## Docker storage maintenance
`src/maintenance.ts` holds the three fixed scopes and their exact Docker
argument arrays, plus best-effort parsing of Docker's `Total reclaimed space`
line. `src/host-maintenance.ts` runs one command at a time through the same
fixed runner, keeps the outcome in memory and never persists or replays it.
`POST /server/maintenance` requires the session, Origin, CSRF and the
confirmation field, reserves the engine synchronously and redirects; the Server
page then shows the running or finished result. The command keeps running when
the browser disconnects, and the page is reloaded by the administrator: there
is no dedicated SSE channel. A timeout or an unconfirmed exit is `unknown`, and
only the unconfirmed case keeps the engine lock.

`StackLocks` carries the engine lock next to the per-stack locks: maintenance
is refused while any stack is locked, and every stack mutation is refused while
maintenance runs. `hasActive()` includes maintenance, so the panel self-update
is refused during a prune. Volumes, containers and networks are never touched;
`docker system prune` is not offered. The panel only sees the daemon behind its
socket, not a separate runner or Docker-in-Docker daemon. See
[ADR 0040](adr/0040-docker-storage-maintenance.md).

## Self-update
`src/self-update.ts` finds the panel's own container (`/proc/self/mountinfo`,
then `container inspect`) and validates its Compose labels, image reference and
socket mount. **Check** pulls that tag, then asks the fixed GitHub repository
for the release of the image's version and the versioned `releases.json`
registry (two fixed, byte-bounded reads sharing one timeout): a published,
non-prerelease release whose digest matches the latest registry entry and the
image's `RepoDigests`. Installation waits 72 hours from the later of release
publication and digest registration ([ADR 0028](adr/0028-versioned-release-registry.md)). The answer is kept
in memory for that image ID. **Install** re-checks the release, then starts a
one-shot `compose-panel-updater` container from the image the panel runs now,
with fixed arguments. Inside it, `src/scripts/self-update.ts` (logic in
`src/self-update-run.ts`) re-verifies the tag, the digest and the config, tags the previous image
`compose-panel:rollback`, recreates the
panel service through the `ComposeProvider` (`serviceImage`, `recreateService`)
and waits for it to be healthy. The finished updater container is the record of
the outcome: the next panel reads its exit code and output from Docker, and
the panel persists nothing. See [ADR 0018](adr/0018-self-update.md).

## Audit log
Auth and action events are written by `src/audit.ts` as append-only NDJSON files, one per day under `<stacksRoot>/.compose-panel/audit/` (overridable), with a bounded number of retained files, a per-file size cap and bounded tail reads. It is not a database and holds no in-memory history: the files on disk are the record (see [ADR 0009](adr/0009-audit-log-and-login-backoff.md)). The same module backs the read-only `/audit` page and the change that replaces per-client login lockout with a bounded delay and one attempt in progress per client, so a single source cannot lock the administrator out.

## Compose provider
Deployment metadata uses the same provider: `stackMetadata` reads resolved
config but returns only allow-listed `stack.*` service labels. Image inspection
is shared with update detection; `src/deployment.ts` projects OCI labels and
full repository digests from the container's actual image ID. Declared metadata
is separate from deployed metadata; neither is stored. See [ADR 0023](adr/0023-deployment-metadata.md); `stack.managed-by` only adds an informational badge ([ADR 0025](adr/0025-declared-deployment-owner.md)).

Engine-specific CLI calls are encapsulated in `src/compose-provider.ts` (see [ADR 0005](adr/0005-compose-provider-boundary.md)). The rest of the code depends on three operations — `listProjects`, `projectServices`, `validateConfig` — never on the concrete executable or its argument layout. V1 implements Docker only; Podman is rejected explicitly rather than emulated. The provider detects its capabilities at startup, and an unsupported operation fails loudly instead of producing a silently wrong result.

## Operations
Four classes, without a generic framework:
1. **Short reads**: discovery, `compose ps`, `compose config`; short timeout.
2. **Long mutations**: allow-listed `up`/`pull`/`stop`/`start`/`restart`/`down`/`pull-up`, built by the provider (`up -d`, detached); one per stack via the lock; the operation is kept in memory and its output is consumed even without a client. Success only on exit 0, timeout reported as unknown. `up`, `restart` and `pull` take one optional validated service (`--no-deps` for the first two, `--` for the last); scoped `up` never creates. An explicit `pull` runs with `--policy always`, so a versioned tag already present is refreshed instead of skipped ([ADR 0021](adr/0021-targeted-service-operations.md), [ADR 0041](adr/0041-targeted-pull-and-remote-image-check.md)).
3. **Remote image check**: one explicit background check per panel at a time, 30-second budget, no lock. `src/image-check.ts` keeps the last result in memory per stack and publishes it only if the generation, effective references and local digests are unchanged; any started mutation drops every stored result (a tag can be shared by several stacks) and a save drops its own stack. The provider owns the fixed `buildx imagetools inspect` call and gives Buildx a writable state directory without touching `DOCKER_CONFIG`. Read-only and outbound: no download, no container change, no cache ([ADR 0041](adr/0041-targeted-pull-and-remote-image-check.md)).
4. **Subscriptions**: `logs --follow`; stop the subprocess when the last reader has left. One subprocess per (stack, service, tail) selection, two selections per stack at most.

A fifth class — declared, non-interactive application actions — runs a declared Composer/npm/Bun script inside a stack service ([ADR 0026](adr/0026-application-toolbox.md));
see *Application actions* below.

## Service rollout (opt-in)
`src/rollout.ts` holds the pure declaration parser, the allow-listed eligibility
rules and the restricted `container inspect` projection. `src/rollout-run.ts`
holds the phase machine. The route is `GET/POST /stacks/<name>/rollout`, exposed
only when `COMPOSE_PANEL_ROLLOUT_ENABLED=true` **and** the service declares
`panel.rollout.enabled: "true"` ([ADR 0035](adr/0035-optional-service-rollout.md)).

The provider gains `pullService`, `scaleService`, `serviceContainerIds` and
`serviceRolloutFacts`; only the latter's allow-listed projection leaves it. A
separate `ContainerMutator` (`src/container-mutations.ts`) owns the three
container-level mutations a rollout needs: `stop --time`, `remove` without
force or volumes, and a fixed `exec <id> touch <path>` for the drain marker.
`ContainerInspector` stays read-only. The rollout reuses the per-stack lock, the
operation view/SSE output and the audit log.

The first drain attempt is irreversible: before it, a candidate created by this
operation may be removed when its full ID, Compose identity labels, creation
date and absence from the initial snapshot prove it; after it, nothing is
removed automatically and the operation reports an intervention. A command whose
exit is unconfirmed is `unknown` and keeps the lock. There is no persistence, no
journal and no replay after a crash. A reverse proxy that discovers both
instances and stops routing to unhealthy ones is an operational prerequisite;
the existing Caddy site integration targets a published loopback port and is not
compatible with this rollout.

## Managed-site creation and generation (opt-in)
`src/managed-site-generate.ts` renders the manifest, `compose.yaml`,
`generated/nginx-site.conf` and `generated/opcache.ini` from bounded form
fields: fixed service names, one pinned runtime channel image, one reserved
127.0.0.1 port and only declared paths below `shared/`. Declared paths resolve
to `<stack>/site/shared/...` through one shared helper, exactly as the profile
check does, and are YAML-quoted. Re-rendering the same manifest yields identical
bytes. The generated gateway resolves the runtime through Docker's embedded DNS
at request time (`resolver` plus a variable `fastcgi_pass`), so a runtime
recreation with a new IP does not leave the kept gateway dialing the old one.
`GET /new-site` and `POST /new-site/preview` are preview-only; `POST /new-site`
calls `src/create-managed-site.ts`, which writes the whole tree in a hidden
`.cp-site-<random>` draft, validates the generated Compose file there, refuses a
known project, and publishes it with one rename. The draft is never a discovered
stack, so an interrupted creation cannot be selected by an action or a save. It
does not fetch, pull or start anything. A failed write leaves no final folder.

`POST /stacks/<name>/baseline` runs under the stack lock and the existing
operation view. It re-checks the effective project and profile, refuses while
Docker reports a running (or unprovable) service, fetches the configured ref
into the first immutable release and switches `current`, without stopping or
recreating a container; it refuses when a pointer already exists. A site whose
manifest declares `build: { kind: "composer" }` is prepared by
`src/managed-site-build.ts` in the same `prepare` phase as a deploy: an offline,
read-only `composer validate` refuses a stale lock, then one disposable
`composer:2.10.3` container runs `composer install --no-scripts --no-plugins`
with only the staging tree mounted. The repository must commit `composer.lock`
(not `vendor/`) and both `composer.json` and the lock's `platform-overrides.php`
must match the site's PHP channel, because that is what install verifies.
Composer's home and cache stay on a bounded tmpfs, the tree is size-monitored
while installing, and a proven container removal is required before publication
(ADR 0045). For a managed site,
Up, Start, Restart and Pull + up are refused until a baseline is provable.
`POST /stacks/<name>/regenerate` is the only writer that replaces generated
files from an existing manifest, after a pending-deploy refusal and under the
lock. Before a port change it checks the reserved port and refuses while a Caddy
domain still routes to the site; it anchors the stack and `generated/`
directories with no-follow handles. Down is refused while a domain is attached.

Generation drift is checked in the operation admission hook, which runs under
the stack lock for every Compose action, deploy, baseline, rollout and app
action. The panel re-renders, compares `compose.yaml`, `generated/nginx-site.conf`
and `generated/opcache.ini` byte-for-byte and refuses with the affected path.
Raw save is refused for a managed site and whenever a manifest exists but
cannot be used; a valid `opt-in` stack keeps its editor. Regeneration is the
explicit repair ([ADR 0042](adr/0042-managed-site-ownership.md)).

## Existing database attachment (opt-in)
`src/managed-site-database.ts` owns the private env-file check:
`site/private/database.env` must be a regular `0600` file owned by the panel
account and at most 64 KiB before Up, Pull + up, Start, Restart or Deploy. It
returns the file path and requirement only; the panel never reads the values.
The manifest parser (v2) accepts one `kind: "existing"` block with a bounded
engine (`mariadb`, `mysql` or `postgresql`) and external network name. The
generator adds a `required: false` env-file entry and the external network to
the runtime service only; the gateway stays on the project network. The profile
projection allows exactly that external network, only on the runtime, and still
requires a shared project network. No database client, arbitrary SQL or
migration exists in the panel; the bounded dump and isolated restore belong to
[ADR 0049](adr/0049-offsite-backup-and-restore.md).

## Offsite backup and verified restore (opt-in)
`src/managed-site-backup.ts` owns the fixed private paths, the metadata-only
credential check, the no-follow staging copy with quotas and SHA-256 inventory,
and the bounded attempt marker. `src/managed-site-backup-run.ts` runs one
`mariadb-dump` container through the fixed `database.cnf` option file (only when
`backup.sql` is declared) and one pinned Restic container with explicit argument
arrays, then verifies the exact snapshot id and `/backup/backup.json`.
`src/managed-site-restore.ts` checks one exact snapshot, extracts it into a
private directory, validates every file against the recorded size and SHA-256,
and imports the SQL half into a disposable internal-network MariaDB instance
before removing it. `POST /stacks/<name>/backup` and
`POST /stacks/<name>/restore` start named operations under the stack lock;
`POST .../backup/acknowledge` clears a marker after inspection. The panel never
reads a credential value, deletes a snapshot, writes a restore over the live
site, starts a scheduler or adds a Restic or database client to its image
([ADR 0049](adr/0049-offsite-backup-and-restore.md)).

## CI-triggered deploy (opt-in)
`src/managed-site-ci.ts` owns the fixed `site/private/ci/` verifier path, the
metadata-only check that reads only a SHA-256 digest, the constant-time token
comparison, the strict request parser, the 300-second window and the durable
bounded nonce/last-attempt record. `POST /api/managed-sites/<stack>/deploy` is
dispatched before the browser session gate, authenticates its own bearer
credential and starts the existing deploy operation under the stack lock; the
deploy then requires the fetched ref tip to equal the requested commit. A
bounded `GET` on the same path returns the site, ref, current release and last
attempt. The panel stores no usable token and gains no scheduler or generic
webhook ([ADR 0050](adr/0050-ci-triggered-deploy.md)).

## Timer-triggered backup (opt-in)
`src/machine-credential.ts` holds the verifier, token, nonce and rate-limit
primitives both machine routes share. `src/managed-site-backup-trigger.ts` owns
the fixed `site/private/backup/trigger-token.sha256` verifier, the strict
nonce/timestamp request, the durable `trigger-state.json` facts (last attempt,
last good snapshot, last verified restore, consumed nonces) and the overdue
computation from the last-success timestamp. `POST
/api/managed-sites/<stack>/backup` is dispatched before the browser session gate,
authenticates its own bearer credential and starts the same backup operation as
the browser button under the stack lock; a successful backup and a verified
restore record their fact. A bounded `GET` returns the declared interval and the
three facts. The panel runs no timer, deletes no snapshot and stores no usable
token ([ADR 0051](adr/0051-timer-triggered-backups.md)).

## Managed-site deploy (opt-in)
`src/managed-site.ts` parses the trusted `compose-panel-site.json` strictly
(bounded size, versioned, unknown/duplicate keys refused). `src/managed-site-profile.ts`
projects `config --format json` onto the allow-listed mount, network, port and
image facts and checks every service against the profile. `src/git-release.ts`
owns the fetch/publish adapter: fixed `git` executable, explicit argv, an
environment built from an allow-list (no inherited config, hooks, credential
helper, prompt or redirect), depth-1 fetch, full-SHA
resolution, `ls-tree` refusal of symlinks and gitlinks before checkout, a
bounded staged-tree walk and one rename into `site/runtime/releases/<sha>`.
`src/managed-site-deploy.ts` owns the phase machine and the rollback decision
table; `src/managed-site-probe.ts` is the fixed loopback probe. The Git adapter
caps the transfer while it runs (object-store polling and a process abort) and
preflights free space before the fetch and the checkout, not only the final
tree. An HTTPS fetch allows only HTTPS. For an SSH URL, the fetch alone
allows SSH and selects the fixed OpenSSH wrapper using `GIT_SSH`. The wrapper
opens the pre-provisioned files in `site/private/ssh` from the staging repo's
working directory. The remaining Git commands use the base environment.
See [ADR 0047](adr/0047-private-git-over-ssh.md).

The route is `POST /stacks/<name>/deploy`, exposed only when
`COMPOSE_PANEL_MANAGED_SITES_ENABLED=true` **and** the manifest is valid
([ADR 0042](adr/0042-managed-site-ownership.md), [ADR 0043](adr/0043-bounded-git-release-lifecycle.md)).
The body carries only the stack name, the CSRF token and a confirmation. Under
the existing per-stack lock and project reservation the panel re-reads the
manifest, resolves the effective Compose project **without** injecting `-p`,
runs the profile check, rejects a runtime image reference that no longer
resolves to the running container's image ID, refuses generated-file drift, and
proves the baseline (pointer, completed metadata, revision script and probe
agree) before fetching anything.

A deploy stops the gateway, switches `current` by one rename, force-recreates
the runtime service and starts the gateway. It verifies that the runtime
container ID changed, that its image ID is still the running one, and that the
gateway container ID did not. It then probes `/.compose-panel/revision` until
one 41-byte body names the intended SHA. A failed verification repeats the whole
sequence in reverse: stop and confirm the gateway, return the pointer, recreate
the runtime, start the gateway and probe the baseline. It reports `rolled back`
only when that probe succeeds. The attempt marker under `site/private/` is
written before the first stop and removed only when the gateway is confirmed
running on the release it must serve; an exception after the stop restarts the
gateway and proves the baseline or reports an intervention, never a silent
success. While the marker exists, Up, Down, Start, Stop, Restart, rollout, app
actions, raw save and a new deploy are refused. The admission hook runs under
the per-stack lock, so a request that passed an earlier check cannot slip in
after an incident; the acknowledgement also takes the lock and is bound to the
attempt ID the page displayed. Reads, logs and the probe remain available, and
only that explicit acknowledgement clears the marker. There is no queue, no
replay and no automatic retry.

## Restart semantics
- Browser disconnect ≠ cancellation.
- `SIGTERM`: stop accepting new mutations, allow a bounded drain window; check that subprocesses have finished.
- Saves accepted before shutdown participate in the same drain deadline as Docker operations and log follows. A save still pending at that deadline has no guaranteed outcome after process exit; no replay occurs.
- `SIGKILL`/crash: the manager's state is lost, **outcome unknown**. No automatic replay. On reconnection, re-read `docker compose ls/ps`.
- V1: no operation persistence. Add an ADR if a durable history requirement is demonstrated.
- Docker must not be started or stopped because of the panel. The panel may disappear without stopping containers already started.

## Application actions
A stack may declare an `x-compose-panel.toolbox.sources` extension in its
canonical Compose file, naming the services, runners (Composer/npm/Bun, or
`exec` for an action that declares its own command, [ADR 0036](adr/0036-exec-runner.md)) and
optional `user`/`workdir` where non-interactive application actions run. Compose
ignores `x-*` fields at deploy time. The extension only says **where**; the
exposed actions come solely from each project's own manifest
(`extra["compose-panel"]` in `composer.json`, `"compose-panel"` in
`package.json`), intersected with its `scripts`. `src/toolbox.ts` holds the pure
parsing, catalog and revision; `src/action-runner.ts` is the Docker adapter
(`docker cp`/`docker exec`). The panel reads the extension from the raw Compose
file with Bun's YAML parser and never rewrites it; multi-file Compose stays
rejected ([ADR 0004](adr/0004-single-file-editing.md)).

Discovery resolves **one** running container per service (`compose ps --status
running -q`) and reads the manifest from that container through `docker cp`
(bounded binary tar stream, never extracted or written to disk; [ADR 0029](adr/0029-bounded-manifest-transfers.md)), never by running the
runner. A service with several running containers is unavailable. A forged or
undeclared action is refused, and the argument array is never built from the
identifier the browser sends. Execution pins the same container id, holds the
per-stack lock before revalidating the manifest under it, and runs a fixed
`docker exec` argument array with no shell, no TTY, no stdin and no
`--privileged`; output reuses the operations/SSE machinery and success is exit 0.
The catalog revision hashes the container id, the image id, the execution
context and the referenced script definitions (including `pre*`/`post*` hooks),
and does not guarantee the immutability of the executed code. See
[ADR 0026](adr/0026-application-toolbox.md).

## External database explorer link (declarative)
A stack may declare an `x-compose-panel.database` extension (a `label` and a
mapping of scalar `query` parameters) in its canonical Compose file. When the
panel has a global `COMPOSE_PANEL_DATABASE_EXPLORER_URL`, the stack page shows
a link that opens an external explorer (LibreDB Studio, Adminer, pgAdmin…) with
those parameters preselected. `src/database.ts` holds the pure parsing,
validation and URL building; `src/config.ts` validates the global URL at
startup and `src/html.ts` renders the card. The panel never contacts the
explorer, reads no credential and opens no database: it only builds a URL from
trusted configuration. The contract is software-agnostic, and no new Docker
boundary is added. See [ADR 0027](adr/0027-external-database-explorer-links.md)
and the [LibreDB example](integrations/libredb.md).

## Caddy site management (optional)
`src/caddy.ts` holds the pure domain model: strict public-domain validation, a
canonical managed file with an ownership header, and strict parsing that
refuses foreign or externally modified files. `src/caddy-helper.ts` is the
privileged host counterpart (entry `src/scripts/caddy-helper.ts`, one JSON
line over stdio for systemd socket activation): it owns one directory of
per-domain files, serializes writers behind an exclusive lock directory, and
runs the prevalidate (import, current config, domain unused) → no-clobber
publish → validate → reload sequence with honest rollback, through fixed
`caddy` argument arrays only. Other host tools join the same lock through
`deploy/caddy/with-caddy-lock.sh`. The panel reaches it
through a bounded Unix-socket client (`src/caddy-client.ts`); attach/detach
(`POST /stacks/<name>/domains/attach|detach`) reuse the mutation guards
(session, Origin, CSRF, per-stack lock, shutdown/self-update refusal, audit)
plus fail-closed Docker checks (deployed identity, `config --services`
membership, loopback-bound port read through the `ContainerInspector`). The
stack page shows attached sites with an application link, a two-step detach
and a GET preview that never mutates. Disabled by default
(`COMPOSE_PANEL_CADDY_ENABLED`, `COMPOSE_PANEL_CADDY_SOCKET_PATH`); with no
socket the section stays a preview. See [ADR 0030](adr/0030-optional-caddy-sites.md).

## Compose context
Stack creation (`src/create-stack.ts`, [ADR 0024](adr/0024-controlled-stack-creation.md))
reserves a new owner-only directory with exclusive mkdir under the shared stack
lock. Validation and effective project-name resolution use private files in
that final directory, with explicit interpolation. Docker discovery is checked
twice for an existing project. Compose is published last with an exclusive hard
link, so stack discovery sees only the completed pair. Linux descriptor-pinned
writes and inode-checked, non-recursive cleanup protect against path substitution.
Creation joins the save drain and audit trail; it never deploys Docker resources.
New directory/file ownership follows the stacks root's uid/gid on Linux, with a
failed transfer aborting creation. Creation and editing share redacted validation
diagnostics. Stack detail loads declared metadata alongside Docker services;
failed config reads produce a fixed warning without exposing stderr. Undeployed
stacks show declared metadata only when present and omit the deployed-image card.

A stack is defined by the paths of its files, its `--project-directory`, its variable sources and its Compose identity. The **folder name is not necessarily the Docker project**. Do not automatically inject `-p <folder>`.

Stacks that contain implicit override files are not displayed or edited: multi-file Compose remains rejected rather than guessed. See [ADR 0004](adr/0004-single-file-editing.md).

New projects have their effective name resolved through the provider before creation. A refreshed Docker project list must not already contain that name; `up`/`pull-up` then use explicit `-p`. Panel operations reserve both the stack and the project identity, so two undeployed directories cannot concurrently create the same project. This is not a transaction with external Compose CLI writers.

On Linux a save keeps the original directory open until commit/rollback completes, preventing deleted-inode reuse from defeating the post-validation directory identity check. Filesystem checks remain point-in-time checks against local writers, not a filesystem transaction.

Draft validation happens in its project directory with a temporary file that is not exposed, `--project-directory` and `-f` explicit, and the candidate `.env` passed through `--env-file`. Relative paths and file order are preserved. Verify that the context used for validation is the same as the context used for execution. Before writing, the current file is backed up under `<root>/.compose-panel/backups/<stack>/` and the replacement is written atomically while preserving the file mode and owner (uid/gid; a new `.env` gets the Compose file's owner and mode 0600).

## Packaging
Only Bun in the application, Docker CLI + Compose plugin in the Linux image. Mount the Docker socket and the stacks directory (host path == container path). No mandatory `node_modules` runtime. Test the build and the exact Docker CLI/Compose plugin compatibility in CI.
