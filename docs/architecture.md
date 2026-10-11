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
[ADR 0014](adr/0014-docker-container-inspection.md).

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

## Audit log
Auth and action events are written by `src/audit.ts` as append-only NDJSON files, one per day under `<stacksRoot>/.compose-panel/audit/` (overridable), with a bounded number of retained files, a per-file size cap and bounded tail reads. It is not a database and holds no in-memory history: the files on disk are the record (see [ADR 0009](adr/0009-audit-log-and-login-backoff.md)). The same module backs the read-only `/audit` page and the change that replaces per-client login lockout with a bounded delay and one attempt in progress per client, so a single source cannot lock the administrator out.

## Compose provider
Engine-specific CLI calls are encapsulated in `src/compose-provider.ts` (see [ADR 0005](adr/0005-compose-provider-boundary.md)). The rest of the code depends on three operations — `listProjects`, `projectServices`, `validateConfig` — never on the concrete executable or its argument layout. V1 implements Docker only; Podman is rejected explicitly rather than emulated. The provider detects its capabilities at startup, and an unsupported operation fails loudly instead of producing a silently wrong result.

## Operations
Three classes, without a generic framework:
1. **Short reads**: discovery, `compose ps`, `compose config`; short timeout.
2. **Long mutations**: allow-listed `up`/`pull`/`stop`/`restart`/`down`/`pull-up`, built by the provider (`up -d`, detached); one per stack via the lock; the operation is kept in memory and its output is consumed even without a client. Success only on exit 0, timeout reported as unknown.
3. **Subscriptions**: `logs --follow`; stop the subprocess when the last reader has left.

## Restart semantics
- Browser disconnect ≠ cancellation.
- `SIGTERM`: stop accepting new mutations, allow a bounded drain window; check that subprocesses have finished.
- Saves accepted before shutdown participate in the same drain deadline as Docker operations and log follows. A save still pending at that deadline has no guaranteed outcome after process exit; no replay occurs.
- `SIGKILL`/crash: the manager's state is lost, **outcome unknown**. No automatic replay. On reconnection, re-read `docker compose ls/ps`.
- V1: no operation persistence. Add an ADR if a durable history requirement is demonstrated.
- Docker must not be started or stopped because of the panel. The panel may disappear without stopping containers already started.

## Compose context
A stack is defined by the paths of its files, its `--project-directory`, its variable sources and its Compose identity. The **folder name is not necessarily the Docker project**. Do not automatically inject `-p <folder>`.

Stacks that contain implicit override files are not displayed or edited: multi-file Compose remains rejected rather than guessed. See [ADR 0004](adr/0004-single-file-editing.md).

New projects have their effective name resolved through the provider before creation. A refreshed Docker project list must not already contain that name; `up`/`pull-up` then use explicit `-p`. Panel operations reserve both the stack and the project identity, so two undeployed directories cannot concurrently create the same project. This is not a transaction with external Compose CLI writers.

On Linux a save keeps the original directory open until commit/rollback completes, preventing deleted-inode reuse from defeating the post-validation directory identity check. Filesystem checks remain point-in-time checks against local writers, not a filesystem transaction.

Draft validation happens in its project directory with a temporary file that is not exposed, `--project-directory` and `-f` explicit, and the candidate `.env` passed through `--env-file`. Relative paths and file order are preserved. Verify that the context used for validation is the same as the context used for execution. Before writing, the current file is backed up under `<root>/.compose-panel/backups/<stack>/` and the replacement is written atomically while preserving the file mode.

## Packaging
Only Bun in the application, Docker CLI + Compose plugin in the Linux image. Mount the Docker socket and the stacks directory (host path == container path). No mandatory `node_modules` runtime. Test the build and the exact Docker CLI/Compose plugin compatibility in CI.
