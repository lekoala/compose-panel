# Architecture

```text
Browser (HTML + minimal JS)
    | GET/POST + EventSource
Bun.serve (1 process, single instance)
    |-- Auth/session/CSRF
    |-- Stack files (read + safe edit)
    |-- Operation manager (in-memory Map, per-stack lock)
    |-- SSE observers / logs (bounded streams)
    `-- Bun.spawn(["docker", "compose", ...], explicit cwd)
          |-- directories /opt/stacks/<name>/compose.yaml + .env
          `-- Docker Engine (source of truth for state)
```

## Operations
Three classes, without a generic framework:
1. **Short reads**: discovery, `compose ps`, `compose config`; short timeout.
2. **Long mutations**: `pull`, `up`, `down`, `restart`; the operation is kept in memory, output is consumed even without a client.
3. **Subscriptions**: `logs --follow`; stop the subprocess when the last reader has left.

## Restart semantics
- Browser disconnect ≠ cancellation.
- `SIGTERM`: stop accepting new mutations, allow a bounded drain window; check that subprocesses have finished.
- `SIGKILL`/crash: the manager's state is lost, **outcome unknown**. No automatic replay. On reconnection, re-read `docker compose ls/ps`.
- V1: no operation persistence. Add an ADR if a durable history requirement is demonstrated.
- Docker must not be started or stopped because of the panel. The panel may disappear without stopping containers already started.

## Compose context
A stack is defined by the paths of its files, its `--project-directory`, its variable sources and its Compose identity. The **folder name is not necessarily the Docker project**. Do not automatically inject `-p <folder>`.

The prototype does not display stacks that contain implicit override files: they will be handled explicitly in the editor phase (P3).

Draft validation happens in its project directory with temporary files that are not exposed. Preserve relative paths and file order. Verify that the context used for validation is the same as the context used for execution. Reject deployments of ambiguous projects at the MVP.

## Packaging
Only Bun in the application, Docker CLI + Compose plugin in the Linux image. Mount the Docker socket and the stacks directory (host path == container path). No mandatory `node_modules` runtime. Test the build and the exact Docker CLI/Compose plugin compatibility in CI.
