# Agent instructions — Compose Panel

Read `README.md`, `docs/product.md`, `docs/architecture.md`, `docs/security.md`, and `docs/roadmap.md` before editing code. This is a minimal application, not a port of an existing panel. Past milestones (P0–P6) are recorded in `docs/roadmap.md` and `CHANGELOG.md`.

## Non-negotiable scope
- One local Linux Docker Engine and one Bun web process. Single trusted administrator.
- Existing Compose directories are the source of truth. Docker is the source of truth for container state.
- HTML from the server, minimal vanilla JS, optional pinned static Actual CSS. No Vue, React, Socket.IO, ORM, Redis, scheduler, generic job framework, remote agents, or interactive terminal.
- No arbitrary Docker command or arbitrary file browser. Only explicit allowed actions.
- No database or durable operation queue in V1. No claim of restart recovery. A crash may leave an operation outcome unknown.
- Compose CLI calls go through the `ComposeProvider` boundary (`src/compose-provider.ts`); do not scatter engine-specific argument building or `if (engine === ...)` checks. V1 targets Docker Compose only.

## Security invariants
1. Auth before non-loopback exposure or any mutation. Keep `127.0.0.1` hard-coded until auth and deployment protections are reviewed.
2. All privileged mutations require authorization AND CSRF protection, including endpoints that trigger Docker commands.
3. Validate stack names before path resolution. Reject symlinks and escapes. Defend filesystem reads/writes against TOCTOU as reasonably possible on Linux.
4. Fixed `docker` executable and explicit argument arrays. NEVER pass user input through `sh -c`, `bash -c`, or equivalent.
5. Compose project identity, working directory, `-f` files, and `.env` interpolation must be explicit and verified before mutation. Do not assume project name equals folder name.
6. `compose.yaml` and `.env` are sensitive; never inject into HTML without escaping, never log secrets, never publish raw interpolated config.
7. One modifying operation per stack, including saves. Closing the browser only stops observation, not the operation. No automatic replay after crash.
8. Never modify running Docker resources during tests on a host Docker daemon. Use isolated disposable test daemons/fixtures.
9. Limit upload sizes, process duration, captured output, log retention and SSE subscribers. Handle broken pipes, errors and signal shutdown.
10. Existing stacks must remain manageable by `docker compose` CLI without this panel.

## Working style
- Language: code, comments, identifiers, tests, UI strings and documentation in English.
- Make one vertical, testable change per PR. Explain why every new dependency is necessary.
- No speculative abstractions, event buses or plugin systems.
- Add regression tests for every nontrivial bug or security issue.
- Preserve existing file contents when reading; never round-trip YAML through a parser on save.
- Use Linux CI for process/signal tests; Windows Bun process behavior is not proof of Linux correctness.
- Clearly mark mock/stub features; do not advertise incomplete functions.
- If docs disagree, open a small ADR. Do not silently redefine scope.

## Quality gates
`bun run test` and `bun run typecheck` (`bun check` builtin, no `tsc` dependency). For Docker-related code, add an isolated Linux integration test and document manual verification before calling the PR done. No live Docker deployment in unattended CI.

## PR report template
Summary; changed files; behavior; failure and rollback behavior; tests run; dependency delta; security considerations; known limitations.
