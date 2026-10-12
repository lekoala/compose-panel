# Operations and validation

## Local development
Use **New stack** on the Stacks page to submit a name, `compose.yaml` text and
optional `.env`. Creation validates the files and the effective project name,
then redirects to the stack; use **Up** separately when ready to deploy. Existing
folders are never replaced. Relative paths resolve in the new stack folder.
Configurations requiring additional files at validation time must be prepared
through the CLI; this form creates only Compose and `.env`.
On validation failure the authenticated form retains your draft. If cleanup is
reported incomplete, inspect the named folder manually before retrying. A crash
may leave a private unfinished directory; the panel does not recover it.
See [ADR 0024](adr/0024-controlled-stack-creation.md) for manual verification.

On Linux new directories and files inherit the stacks root's uid/gid, with
0700 directory permissions and 0600 files (including `.env`). Set the root's
owner to the host administrator who will use Compose; other users/groups do not
gain access. Failure to transfer ownership aborts creation.

Creation requires a filesystem allowing hard links for exclusive publication.
Some Docker Desktop shares or FUSE/NFS mounts may refuse these; the form reports
the publication error and cleans up its files. Use compatible local Linux storage
or correct the mount permissions; there is no unsafe overwrite fallback.

Project collision checks cover deployed Docker projects. Two undeployed folders
may still declare the same `name:`; Up checks ownership again before deployment.

The panel runs real Docker commands for state, validation, operations and log follows. On Windows, developing HTML and pure logic is possible without Docker. Process, signal and Docker tests must pass on Linux (CI).

## Safety of future commands
Add new operations to the `ComposeProvider` (`src/compose-provider.ts`), not to controllers. The Docker provider builds calls with `Bun.spawn(["docker", "compose", ...], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })`. Do not use a shell. Consume both streams even if no SSE is connected. Set timeouts and output caps. Preserve the argument order, the project directory, any Compose files and env sources.

Reads that can replace a long-running subscription belong on the boundary too. `readLogs` (one-shot `compose logs --tail N --timestamps --no-color`, bounded by the runner timeout and output cap) is the counterpart to `followLogs`: it serves the history snapshot the stack page loads on open, while `LogManager` keeps owning only the SSE follow.

## YAML validation
Use `docker compose config --quiet` with the effective project and explicit input files. This is not a dry-run of `up`. Test that build and volume paths stay the same between the validated draft and the saved version. Do not log `config --environment` or an interpolated YAML containing secrets.

## Before switching over from another panel
Coming from Dockge: follow [migrating-from-dockge.md](migrating-from-dockge.md). In general:
- Back up the stacks directories and the other panel's data volume (rollback).
- Keep exactly the same absolute paths mounted for the stacks.
- Stop **concurrent administration operations** between the two panels. Do not run both in write mode at the same time.
- Validate the Compose plugin, socket access, restoration and rollback on a test machine.
- After the switch-over, Docker stays autonomous; no stack should be restarted just because the panel restarts.

## Diagnostics
An `unknown` means a command failed or the project identity could not be established, not that the stack is stopped. An operation interrupted by a crash may have partially acted on Docker; re-read the state before retrying.

If a command is stopped at its time limit, the panel reports an **unknown** outcome and does not claim the work stopped. When the process exit could not be confirmed, the stack's lock is kept on purpose: no new action, save or deployment starts for that stack until the panel restarts. This guard is in memory only (it is not persisted), so a panel restart releases it. Inspect the stack on the host (for example with `docker compose ps` and the panel's own logs) before restarting the panel and retrying.

## Technical references
- [Bun.spawn — official documentation](https://bun.com/docs/runtime/child-process)
- [Bun HTTP server, SSE, timeout](https://bun.com/docs/runtime/http/server)
- [Docker Compose, project options and files](https://docs.docker.com/reference/cli/docker/compose/)
- [Docker Compose config](https://docs.docker.com/reference/cli/docker/compose/config/)
## Deployment metadata

The stack detail page reads the actual image ID of every container, including
stopped containers, pinned images and local builds. OCI labels
`org.opencontainers.image.version`, `.revision` and `.source` describe that
image. Repository digests are shown in full when Docker has them; the image ID
is separate and is not a registry manifest digest. Replicas may differ.

Declare optional metadata under each service's `labels` using the generic
`stack.*` convention:

```yaml
services:
  app:
    image: registry.example.com/app:stable
    labels:
      stack.environment: staging
      stack.version: "${APP_VERSION}"
      stack.revision: "${APP_COMMIT}"
      stack.branch: main
      stack.build: "428"
      stack.build.url: https://ci.example.com/builds/428
      stack.source: https://git.example.com/app
      stack.url: https://staging.example.com
      stack.managed-by: Example CI
```

Only these nine labels are read. Resolved values are displayed as **declared
Compose metadata**, separately from the deployed image: editing a file does not
change a running container. When all declaring services agree,
`stack.managed-by` adds a **Managed by** badge and a warning in Actions that an
external deployment may overwrite changes made from the panel; it never blocks
an action ([ADR 0025](adr/0025-declared-deployment-owner.md)). Put no secrets in these labels. Links allow HTTP(S)
only and do not prove reachability. No URL is fetched by the panel.

`bun run preview` includes a simulated `release` stack: open it, try **Pull**
and then **Up**. The deployed version stays at 2.4.0 until Up changes it to
2.5.0; declared metadata stays as written in the file. All preview metadata and
links are fictional. See [ADR 0023](adr/0023-deployment-metadata.md) for the
isolated Linux test and manual verification procedure.

## Application actions

A stack can offer non-interactive maintenance actions (clear a cache, apply
migrations, run a health check) through the **App actions** page. Two files
declare them, and the split is deliberate:

- The Compose file says **where** to run, through an `x-compose-panel` extension
  that Compose ignores at deploy time:

  ```yaml
  x-compose-panel:
    toolbox:
      sources:
        - id: backend
          service: app
          runner: composer
          workdir: /app
          user: www-data
  ```

  `service` and `runner` (`composer`, `npm` or `bun`) are required; `workdir` and
  `user` are optional and otherwise use the container's own defaults. A `workdir`
  must be an absolute path inside the container.

- The project manifest says **what** may run, only through declared actions:

  ```json
  {
    "scripts": { "cache:clear": "php bin/console cache:clear" },
    "extra": {
      "compose-panel": {
        "version": 1,
        "actions": { "cache:clear": { "label": "Clear the cache", "timeout": 120 } }
      }
    }
  }
  ```

  For `package.json`, use a root `"compose-panel"` property instead of
  `extra`. Only the listed actions are exposed; every key must name an existing
  entry of `scripts`. The panel launches the runner (`composer run-script`,
  `npm run`, `bun run`), never the extracted command, so `pre`/`post` hooks keep
  working.

The panel reads the manifest from the running container, launches the action
with a fixed argument array (no shell, no TTY, no free arguments) under the
per-stack lock, and streams the bounded output like any other operation. The
service must be running, with exactly one container; a stopped service or a
service with several replicas is unavailable. If the manifest changes between
loading the page and clicking, the run is refused and asks you to reload.

The manifest is trusted code, like the Compose file: a deployment can change an
action's behavior. The tool's timeout is honest — a run stopped at the limit is
reported as an unknown outcome, and the panel cannot guarantee that the work
inside the container stopped. The image must provide the runner on its `PATH`;
the panel never installs Composer, npm or Bun.

Composer applies its own `config.process-timeout` (300 s by default) to a
script, so a larger `timeout` in the manifest has no effect until that setting is
raised. The panel passes `--no-interaction`, so a prompt such as "Continue as
root?" never blocks the action. See
[ADR 0026](adr/0026-application-toolbox.md).
