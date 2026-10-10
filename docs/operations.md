# Operations and validation

## Local development
The panel runs real Docker commands for state, validation, operations and log follows. On Windows, developing HTML and pure logic is possible without Docker. Process, signal and Docker tests must pass on Linux (CI).

## Safety of future commands
Add new operations to the `ComposeProvider` (`src/compose-provider.ts`), not to controllers. The Docker provider builds calls with `Bun.spawn(["docker", "compose", ...], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })`. Do not use a shell. Consume both streams even if no SSE is connected. Set timeouts and output caps. Preserve the argument order, the project directory, any Compose files and env sources.

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

## Technical references
- [Bun.spawn — official documentation](https://bun.com/docs/runtime/child-process)
- [Bun HTTP server, SSE, timeout](https://bun.com/docs/runtime/http/server)
- [Docker Compose, project options and files](https://docs.docker.com/reference/cli/docker/compose/)
- [Docker Compose config](https://docs.docker.com/reference/cli/docker/compose/config/)
