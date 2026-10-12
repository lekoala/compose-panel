# ADR 0026 — Application actions toolbox

Status: Accepted

## Context

The panel manages the stack lifecycle today: create, edit, validate, deploy,
logs and inspect. Administrators also need to run a small number of
**application** maintenance operations inside a stack (clear a cache, apply
migrations, run a health check) from the same interface, without the panel
becoming a terminal or a generic command runner.

Projects already declare these operations with the tools they use: Composer
scripts in `composer.json`, scripts in `package.json` run by npm or Bun.
Reusing those conventions avoids a second list of commands to maintain and a
bespoke automation engine.

This ADR defines the contract and the security boundary. `src/toolbox.ts` holds
the pure parsing, validation, catalog and revision; `src/action-runner.ts` is
the Docker adapter that reads a manifest (`docker cp`) and launches an action
(`docker exec`). The exploration that led here is in `private/toolbox.md`,
which is historical and not normative.

## Decision

### Scope

Only the **application** toolbox is accepted here. A host toolbox (a host-side
runner, a Unix socket, sudoers entries, systemd units) stays out of scope and
would need its own ADR. The panel does not become a general Linux administration
panel.

### Manifest contract: declaration is authorization

A project declares its exposed operations next to its scripts, with the same
schema in both ecosystems and a schema version from the start:

- Composer: `extra["compose-panel"]`.
- `package.json`: a root `"compose-panel"` property.

```json
{
  "version": 1,
  "actions": {
    "cache:clear": { "label": "Clear the cache" },
    "db:migrate": {
      "label": "Apply migrations",
      "group": "Database",
      "confirmation": "Apply migrations to this database?",
      "timeout": 300
    }
  }
}
```

- Only scripts listed under `actions` are exposed. Every other script stays
  invisible and cannot be launched.
- Every action key must name an existing entry of `scripts`. An action with no
  matching script is a configuration error, never an executable button.
- The manifest is trusted code, like the Compose file and the deployed
  application. Declaring an action exposes it: there is no second approval step
  and no mandatory re-approval after a deployment.

### Runners

The runner is explicit in the stack configuration and is never inferred from a
lockfile.

| Manifest        | Runner     | Execution                    |
| --------------- | ---------- | ---------------------------- |
| `composer.json` | `composer` | `composer run-script <name>` |
| `package.json`  | `npm`      | `npm run <name>`             |
| `package.json`  | `bun`      | `bun run <name>`             |

The panel launches the runner, it does not extract the script body and run it
itself. This preserves the tool's semantics, including npm's `pre<name>` and
`post<name>` hooks and Composer's hook and callback scripts. `pnpm` and others
can be added later without changing the schema.

`bun run <name>` also resolves files and binaries when the name is not a script,
so the action name MUST be confirmed against the parsed `scripts` before any
command is built. The same membership check applies to Composer and npm even
though they fail on an unknown script.

### Stack configuration: where to run

The stack names its sources in the canonical Compose file, using a Compose
extension field that Compose ignores at deploy time:

```yaml
x-compose-panel:
  toolbox:
    sources:
      - id: backend
        service: app
        runner: composer
        workdir: /app
        user: www-data
      - id: frontend
        service: node
        runner: bun
```

The extension describes **where** to run; it never authorizes an action. The
exposed actions remain exactly those declared in the application manifest.
`service` and `runner` are required. `workdir` and `user` are optional: when
absent, the container's own default is used, which is usually more reliable for
npm and Composer than forcing a user. A supplied `workdir` must be an absolute
path inside the container; `user` accepts a name, a uid, or `uid:gid` as
`docker exec -u` does, but never a value that looks like an option.

The panel reads this field from the raw Compose file and never rewrites the
file. Multi-file Compose stays rejected ([ADR 0004](0004-single-file-editing.md)),
so V1 covers only the single canonical Compose model the panel already supports.

### Action identifiers

An action identifier is a script name from the manifest. The backend validates
it against a strict grammar and refuses any name that could be read as a CLI
option (for example a leading `-`), for all three runners. The browser sends an
identifier; the backend resolves it in the catalog and never builds the argument
array from the transmitted name directly.

### Discovery

On opening the Actions view or on refresh:

1. Resolve the stack and its usual Compose context through the
   `ComposeProvider`.
2. Verify the target service has **exactly one running container**. Several
   running containers (replicas) make the action explicitly unavailable in V1:
   no arbitrary pick, no `--index`, no fan-out.
3. Read the manifest from that container's filesystem
   (`docker cp -- <id>:<path> <private temp dir>`) rather than from a host
   copy, which may not match what is deployed. The **read** is size-capped; the
   **transfer is not**: Docker `cp` copies the whole object, so a directory or a
   symlink is refused, the temp directory is private, the copy has a timeout and
   cleanup always runs. The panel does not run Composer, npm or Bun to discover
   actions.
4. Parse the JSON, validate the `compose-panel` section and intersect the
   declared actions with `scripts`.
5. Build the displayable catalog and a `catalogRevision`.

If the service is not running, the Actions view says so explicitly; the panel
does not start a container to read a manifest.

### Execution

The browser sends only identifiers, for example
`{ source, action, catalogRevision }`. The backend:

1. Rechecks authorization and CSRF.
2. Makes a friendly pre-check **without** the lock; a missing source, a changed
   catalog or an unreachable service is answered as an error (`400`/`404`/`409`)
   and nothing starts.
3. Acquires the per-stack lock (the same lock as deployments and saves).
4. **Under the lock**, re-reads the Compose declaration, re-resolves the project
   context (and verifies it is still the reserved project), re-reads the manifest
   from the pinned container and revalidates that the action is still exposed and
   the catalog revision is unchanged. A mismatch here is not an HTTP `409`: the
   operation was already accepted, so it ends as **`refused`** — nothing runs and
   the audit line says so.
5. Builds a fixed argument array from the resolved action, with no shell
   interpolation.
6. Runs `docker exec <id>` on the **same container** that was read, with no TTY
   and no interactive stdin, no `--privileged`, and only the configured
   user/workdir. Composer is launched with `--no-interaction`.
7. Streams bounded stdout/stderr through the existing operations/SSE machinery
   and records the operation.

Success is reported only on exit 0. A timeout is reported as an unknown outcome,
never as cancelled: stopping the CLI does not guarantee the work inside the
container stopped. As for a Compose operation, the lock is released only when the
process exit is confirmed; an unconfirmed termination keeps it held. A
confirmed exit releases the lock even though the in-container work may continue,
which the UI states honestly rather than presenting the action as stopped.

### Catalog revision

`catalogRevision` is the hash of the pinned container id, the image id, the
execution context (runner, workdir, user) and **every script definition in the
manifest**, not only the declared actions. A Composer `@other` reference, an
npm/Bun `pre<name>`/`post<name>` hook or any volume-mounted edit that leaves
`extra.compose-panel` untouched therefore still yields a different revision. It
detects a manifest changed between display and launch, including a script body
changed by a bind mount while the container and image ids stay the same. It is
not a permanent approval: a new deployment may change the behavior of an action,
exactly as it changes the application. The revision does not prove that all
executed code is immutable.

The audit record names what actually ran: the action id, the source id, the
pinned container id, the image id, the catalog revision, the start/end times and
the exit code (or a timeout). Output is bounded in the operation view but is
never written to the activity log, which may hold no secrets.

### Security boundary

This ADR replaces the absolute "no `exec`" wording of
[ADR 0014](0014-docker-container-inspection.md) with: **Compose Panel exposes no
arbitrary command execution and no interactive terminal; it executes only
explicitly declared, non-interactive application actions inside a running stack
service.** The generic "run command" endpoint stays prohibited; the new
capability is a closed, declared set of actions.

`docker cp` and `docker exec` are new members of the fixed Docker boundary, built
with explicit argument arrays and no shell, like the existing read commands. The
lock protects panel operations only, not external Docker writers, and the
container is pinned so an action discovered on one container is never executed
on another. Confirmation is a UI safeguard; the backend always revalidates.

## Consequences

- `architecture.md`, `security.md`, `product.md` and `roadmap.md` carry the
  feature; `docs/operations.md` documents it for operators.
- No new dependency: Bun's YAML parser reads the Compose extension, and the
  Compose file is never re-serialized.
- An action is bound to the deployed image; a new deployment may change its
  behavior without an administrator action. This is accepted for the single
  trusted administrator who already decides what is deployed.

## Alternatives considered

- A panel-owned per-stack config file (`.compose-panel/toolbox/<stack>.yaml`) or
  a global panel config: rejected in favour of the Compose extension, which
  keeps a stack self-contained and follows it across renames and removals.
- `docker compose exec <service>` with service revalidation: rejected in favour
  of pinning the exact container id, so discovery and execution cannot diverge.
- A mandatory content hash and re-approval after every change: rejected as
  ineffective (a JSON hash does not cover the executed code or hooks) and as
  unnecessary friction for a single trusted administrator.
- A host toolbox with a runner, socket, sudoers and systemd: deferred; separate
  ADR if a concrete need appears.

## Verification

Unit tests (`tests/toolbox.test.ts`, `tests/action-runner.test.ts`) cover the
source and manifest parsing (including a cyclic YAML alias, a relative/escaping
`workdir`, a duplicate id, an unsupported version, a `uid:gid` user), the
action-name grammar (option-like names refused), a per-runner runnable script
definition, the `bun run` file-resolution case (own membership in `scripts`), the
runner argv (Composer `--no-interaction`), the timeout clamp, and a revision that
changes with the script body, a referenced Composer script, the runner, the user,
the workdir or the container — and stays stable otherwise.
`tests/toolbox-app.test.ts` covers auth, CSRF, an unknown source, an undeclared
action, a forged request and unpublished changes (`409`), a stopped service,
replicas, the fixed `exec` argv on success, the `refused` outcome of an under-lock
revalidation, and the audit identity line. `tests/action-runner.test.ts` also
covers a refused directory and (where the platform allows creating one) a refused
symlink, a size-capped read and a temporary-directory cleanup. `tests/html.test.ts`
covers the `constructor`-named action label regression.

Manual verification on a Linux host with a disposable stack: declare a source
and a manifest, confirm the Actions page lists the action, run it and watch the
live output and final state, then change the script and confirm a stale page is
refused. `tests/toolbox-linux.test.ts` automates the Docker boundary (a manifest
read and a real `npm run`) against the disposable daemon from
`scripts/docker-lab/run.sh`; it mutates Docker, so it is opt-in and never runs in
unattended CI.

## Out of scope

Host toolbox; user-supplied arguments; interactive stdin/TTY; replicas and
`--index`; automatic package-manager detection; mandatory re-approval; a
progress daemon or durable history.
