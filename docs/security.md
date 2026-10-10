# Security — mandatory boundaries

## Main risk
An administrator able to edit and then deploy a Compose file on a rootful Docker daemon can obtain very high control over the host. This panel is **not** a Docker sandbox, nor a multi-tenant API. Trusted users only.

## Delivered entry protections (P1)
- Local loopback `127.0.0.1` only, no exposed bind. A single administrator authenticates; the password is stored only as an Argon2id hash (`Bun.password`) supplied outside the repo.
- Sessions are random server-side identifiers kept in memory (lost on restart). Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` when `COMPOSE_PANEL_COOKIE_SECURE=true`; the session id rotates on login.
- All mutating requests (login, logout) require a matching CSRF token and an exact Origin/Referer match. The login page uses a double-submit CSRF cookie; authenticated pages use a per-session token.
- Login attempts are rate-limited per client; request bodies and login payloads are size-bounded; every application response is `Cache-Control: no-store`.
- Docker calls are reads by default; editing and the fixed operation allow-list are the only mutations, all authenticated and CSRF-protected. Compose files may still contain secrets: do NOT place the panel behind a public proxy yet.

## Safe editing (P3)
- `compose.yaml` and `.env` are read and written as raw text: never parsed and re-serialized, so comments and formatting are preserved. Writes are atomic (temp file in the same directory, then rename) and keep the original file mode.
- Optimistic concurrency: the form carries a content hash for each file; if either changed on disk the save is refused (409) instead of overwriting an external change.
- Drafts are validated with `docker compose config --quiet` only, in the real project directory with explicit `--project-directory`, `-f` and, when the env is edited, `--env-file`. The interpolated config is never printed or logged.
- Values from `.env` are redacted from any validation error before it reaches the page. Symlinked files are refused, and a missing `.env` is not created unless it has content.
- Backup directories (`<root>/.compose-panel/backups/<stack>/`) are lstat-checked component by component: symlinks and non-directories are refused and created directories are owner-only. The stack directory identity (dev/ino) is revalidated after the validation window, so a swapped directory is a conflict even with identical content. These checks are point-in-time: they close the window to the commit instant but are not a transaction against a privileged local writer racing `rename` itself.
- Every save first copies the previous file to `<root>/.compose-panel/backups/<stack>/`; if writing the second file of the pair fails, the first is restored and the failure is reported as partial with backup references, never as success. Files are re-read after validation, so an external change during the validation window is a conflict, not a silent overwrite. A save is a modifying operation and holds the per-stack lock.

## Operations (P4)
- Mutating actions are a fixed allow-list (`up`, `stop`, `restart`, `down`, `pull-up`); there is no generic "run command" endpoint and no user-supplied option.
- Every operation runs through the provider with an explicit `--project-directory` and `-f`, plus `-p` when the project is known. The folder name is never assumed to be the project name.
- Mutations and log follows fail closed on the project context: ambiguous matches and unreachable Docker discovery refuse to act (`409`/`503`) instead of running without `-p`. An undeployed stack only allows creation (`up`, `pull-up`); destructive actions require a resolved project. Draft validation reuses the resolved `-p` identity when known.
- Before creation, Compose resolves the effective project name from the actual file and interpolation environment. Discovery is refreshed and a name already owned by another project is refused; creation pins the verified name with `-p`. Effective config is captured only inside the provider to extract that name and is never published or logged. Concurrent panel operations also reserve the project name, including across different stack directories. External CLI writers do not share this in-memory reservation: discovery remains a point-in-time check.
- Process timeouts and log aborts request `SIGTERM`, escalate to `SIGKILL` after 250 ms and stop waiting after 1 second. Linux spawns own a separate process group, so signals reach the Compose plugin child as well as the CLI parent. An unconfirmed exit or pipe cleanup is an unknown outcome; the stack/project lock remains held to prevent overlapping mutations. A stopped log follow similarly blocks replacement until its exit is confirmed. These guards are in memory and disappear on restart; verify the actual Docker state before retrying after a crash.
- One operation per stack, enforced by the same per-stack lock as saves; a second request is rejected with `409`. `up` is detached and the panel never attaches a terminal.
- Success is reported only after exit 0; a timeout is `unknown`; a second file/op state is never invented. Browser disconnect does not cancel an operation.
- On `SIGTERM`/`SIGINT`, new operations, saves and log follows are refused synchronously before anything is awaited, then running work drains under one shared deadline. There is no persistence and no automatic replay: after a crash the outcome may be unknown and the UI re-reads Docker.
- Operation output is captured from both streams and bounded; pipe chunks stream to observers while the command runs (retention stays head-capped with a truncation flag). Output is HTML-escaped before display and never written to application logs.

## Streaming (P5)
- Both event streams require an authenticated session and answer `401` (never a login redirect) without one. Stack names are validated exactly like reads; unknown stacks are `404`.
- Operation SSE is observation-only: subscribing never starts or cancels work, and disconnecting never stops a running operation. The `done` frame is sent only after a terminal state; the stream also ends on heartbeat timeout.
- Log follow spawns `compose logs --follow --tail N --timestamps` through the provider with an explicit argument array (no shell), one subprocess per stack at most. The subprocess is killed when the last reader leaves, when the explicit timeout fires, or on server shutdown. Readers share the process; they never pass options.
- Bounds: process-wide subscriber cap (`503` past it), per-stack retained log buffer (tail-kept, flagged), heartbeat, explicit stream/follow timeouts, and slow readers are dropped instead of buffering unbounded output for them. ANSI color escapes are stripped before broadcast.
- The browser inserts stream text via `textContent` only. CSP allows same-origin scripts (`/app.js`) and same-origin EventSource connections; Docker logs may contain secrets and are therefore behind auth with `no-store`, like the Compose file.
- Pipe decoders preserve UTF-8 across reads. SSE output/chunk payloads carry JSON text fragments so carriage returns, newlines and partial lines survive framing and browser insertion exactly. Following an absent project returns an empty ended stream without spawning Compose.

## Proxy and TLS contract
- Default remains direct loopback HTTP with `COMPOSE_PANEL_COOKIE_SECURE=false`.
- Behind TLS, set `COMPOSE_PANEL_COOKIE_SECURE=true` and, for a proxy, `COMPOSE_PANEL_PUBLIC_ORIGIN=https://<host>` so Origin checks compare against the public origin. Set `COMPOSE_PANEL_TRUST_PROXY=true` only when the proxy overwrites `X-Forwarded-Proto`/`X-Forwarded-For`.
- Bind stays hard-coded to `127.0.0.1` until the reverse proxy, TLS termination and firewall are reviewed and documented.

## Minimum before remote/production use
- Auth mono-admin (secret provisioned outside repo, robust password derivation, cookies HttpOnly, Secure, SameSite, rotation de session après login, logout). *(implemented in P1)*
- CSRF on all POSTs and strict Origin/Host checks, behind an explicitly configured proxy. *(CSRF and same-origin checks implemented in P1; proxy configuration still to be verified on a real deployment)*
- TLS via proxy, bind on a private interface, firewall/administration network. Never expose the Docker socket over TCP.
- Limit file sizes, execution time, log/SSE size, login attempts. *(login attempts, request body size, edit sizes, Docker/operation caps, SSE subscribers/heartbeat/timeout and log tail/buffer/timeout implemented in P1–P5)*
- Escape HTML, restrictive CSP, disable caching of sensitive pages, protect any response containing `.env`.
- Ensure safe resolution of names and files: name allow-list, reject symlinks, protect the root path, no absolute paths supplied by the user.
- Subprocesses via argument arrays, no shell. No freely user-supplied options. No generic Docker command. *(read-only `compose ls`/`ps` implemented in P2 with a fixed executable, timeouts and output caps; mutations arrive in P4)*
- Backups before modifications, controlled concurrency, operation limits and graceful shutdown. *(backup, per-stack lock, optimistic concurrency and the operations manager implemented in P3–P4; shutdown drains running operations)*
- Docker logs may themselves contain secrets. Never include them in unprotected application logs.

## Mandatory security checks
Tests for `../` paths, encoded URLs, trailing-newline/NUL/double-encoded names, missing STACKS_DIR (fail-closed 503, no Docker call), non-conforming names, symlinks, double Compose, `.env` symlink, write conflicts, secrets in errors, CSRF, XSS, concurrent operations, malformed Docker CLI output, timeout/output-cap handling, SSE auth/subscriber limits/slow readers, log follow kill-on-last-reader/timeout, Linux shutdown/restart and stuck processes.

## CI
Subprocess tests only in a disposable/isolated Docker daemon. Never mount the CI host's production engine socket in automated tests.
