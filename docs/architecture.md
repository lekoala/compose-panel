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
[ADR 0015](adr/0015-readonly-engine-insights.md).

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
Three classes, without a generic framework:
1. **Short reads**: discovery, `compose ps`, `compose config`; short timeout.
2. **Long mutations**: allow-listed `up`/`pull`/`stop`/`start`/`restart`/`down`/`pull-up`, built by the provider (`up -d`, detached); one per stack via the lock; the operation is kept in memory and its output is consumed even without a client. Success only on exit 0, timeout reported as unknown. `up` and `restart` take one optional validated service (`--no-deps -- <service>`); scoped `up` never creates.
3. **Subscriptions**: `logs --follow`; stop the subprocess when the last reader has left. One subprocess per (stack, service, tail) selection, two selections per stack at most.

A fourth class — declared, non-interactive application actions — runs a
declared Composer/npm/Bun script inside a stack service ([ADR 0026](adr/0026-application-toolbox.md));
see *Application actions* below.

## Restart semantics
- Browser disconnect ≠ cancellation.
- `SIGTERM`: stop accepting new mutations, allow a bounded drain window; check that subprocesses have finished.
- Saves accepted before shutdown participate in the same drain deadline as Docker operations and log follows. A save still pending at that deadline has no guaranteed outcome after process exit; no replay occurs.
- `SIGKILL`/crash: the manager's state is lost, **outcome unknown**. No automatic replay. On reconnection, re-read `docker compose ls/ps`.
- V1: no operation persistence. Add an ADR if a durable history requirement is demonstrated.
- Docker must not be started or stopped because of the panel. The panel may disappear without stopping containers already started.

## Application actions
A stack may declare an `x-compose-panel.toolbox.sources` extension in its
canonical Compose file, naming the services, runners (Composer/npm/Bun) and
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
runs the safe prepare → validate → publish → reload sequence with honest
rollback, through fixed `caddy` argument arrays only. The panel reaches it
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
