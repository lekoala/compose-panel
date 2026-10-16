# Security — mandatory boundaries

## Main risk
Stack creation (`POST /new-stack`, ADR 0024) requires an active session, valid
Origin and CSRF, bounded inputs and a validated stack name before path use.
Existing paths are refused by exclusive mkdir. Validation uses the exact new
directory and explicit `.env`; project collisions and failed discovery refuse
publication. Files are 0600 in a 0700 directory; on Linux both inherit the uid/gid
of the stacks root, failing creation if chown is refused. Linux writes and cleanup use
pinned directories and inode checks; cleanup never recursively deletes a
user-named directory. Failed cleanup reports a partial outcome and keeps a safe
original cause; logs include only the stack and fixed creation phase. Compose
validation stderr uses the same redaction and bounds as editing and is suppressed
when timed out or truncated. Other provider errors use fixed messages; the audit
records only name and result.
Authorization, shutdown and self-update state are rechecked before publication.

Deployment metadata is authenticated and `no-store` like the stack detail.
Resolved Compose config is projected inside the provider onto an explicit
label allow-list; other labels, environment and stderr are never returned.
All metadata is bounded and escaped. Links allow HTTP(S) without credentials,
open with `noopener noreferrer`, and are never fetched by the panel.
`stack.managed-by` is display-only: it never disables an action, changes
authorization or counts as proof of who deployed the stack (ADR 0025).

An administrator able to edit and then deploy a Compose file on a rootful Docker daemon can obtain very high control over the host. This panel is **not** a Docker sandbox, nor a multi-tenant API. Trusted users only.

## Delivered entry protections (P1)
- The production HTTP listener explicitly disables Bun development errors; uncaught request errors return a generic, non-cacheable text 500 without the thrown value in the response or fallback log. The image sets `NODE_ENV=production`.
- Local loopback `127.0.0.1` only, no exposed bind. A single administrator authenticates; the password is stored only as an Argon2id hash (`Bun.password`) supplied outside the repo.
- Common/guessable administrator usernames (`admin`, `administrator`, `root`, `user`, `test`, `guest`) are refused at startup unless `COMPOSE_PANEL_DEV=true` (local development only). A unique `COMPOSE_PANEL_ADMIN_USER` is required.
- Sessions are random server-side identifiers kept in memory (lost on restart). Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` on an https proxy origin or when `COMPOSE_PANEL_COOKIE_SECURE=true` (the direct/loopback path); the session id rotates on login.
- All mutating requests (login, logout) require a matching CSRF token and an exact Origin/Referer match. The login page uses a double-submit CSRF cookie; authenticated pages use a per-session token.
- A save or operation re-checks that its session is still active (without refreshing idle activity) after the request body is read, after the awaited project discovery for an operation, and after validation just before a save writes anything. A request left pending across logout or expiry therefore does nothing and answers `401`. Work already accepted before the session ended keeps running, as documented for operations.
- Login attempts are rate-limited per client; request bodies and login payloads are size-bounded; every application response is `Cache-Control: no-store`.
- The attempt is reserved synchronously before any awaited password verification, so a burst of concurrent logins cannot all pass the limit before the first failure is recorded. Over-limit attempts are **not refused**: they are served with a bounded, exponentially growing delay. Each client key may have one attempt in progress (a parallel one is refused, so the delay cannot be bypassed), and the global in-flight verification cap is taken only after the delay. A single source therefore cannot lock the administrator out; many distinct sources can still cause transient refusals, which is a host-level concern (see [ADR 0009](adr/0009-audit-log-and-login-backoff.md)). Behind a trusted proxy the client key is the last `X-Forwarded-For` entry, the one the proxy appended.
- Attempt tracking is bounded to 10,000 distinct client keys. Past that, a key not yet tracked is refused (`429` with `Retry-After`) until the oldest window expires; tracked keys are never evicted, so no existing delay is silently reset. Expiry work is amortized: entries stay in window-start order and only expired ones are visited.
- Docker calls are reads by default; editing and the fixed operation allow-list are the only mutations, all authenticated and CSRF-protected. Compose files may still contain secrets: expose the panel only through the reverse proxy mode below, never through a published port.

## Safe editing (P3)
- `compose.yaml` and `.env` are read and written as raw text: never parsed and re-serialized, so comments and formatting are preserved. Writes are atomic (temp file in the same directory, then rename) and keep the original file mode and owner, so a panel running as root does not take ownership of user files. A new `.env` is created 0600 and owned like the Compose file. On Linux, a failed ownership or permission transfer refuses the replacement and removes the temporary file; a failure after the first file of a pair was replaced uses the existing rollback. Windows cannot validate POSIX ownership semantics.
- Optimistic concurrency: the form carries a content hash for each file; if either changed on disk the save is refused (409) instead of overwriting an external change.
- Drafts are validated with `docker compose config --quiet` only, in the real project directory with explicit `--project-directory`, `-f` and, when the env is edited, `--env-file`. The interpolated config is never printed or logged.
- Values from `.env` are redacted from any validation error before it reaches the page. Symlinked files are refused, and a missing `.env` is not created unless it has content.
- The secret collector follows the supported `.env` value syntax (inline comments, single/double quotes including `\'`/`\\` escapes, `export`, quoted values spanning several lines), and redaction runs before output is truncated so a value crossing the line/char boundary cannot leak as a prefix. Longer values are redacted first, so a short value contained in a longer one cannot leave the rest readable; a multiline value is redacted whole, with escaped newlines, and line by line. When the subprocess runner already cut the diagnostic at its capture cap, a fixed message replaces it, because a secret crossing that cut cannot be recognized. Values built by interpolation from other variables are not reconstructed and are not covered.
- Mutations and log follows resolve the project context through the same `.env` safety rules as the editor: a symlinked, non-regular or oversized `.env` is refused (`409`) before any Docker call, and a verified `.env` is passed explicitly with `--env-file` so Compose cannot read one implicitly.
- Stack detail verifies `.env` before `config`, `ps` or `images`. An unsafe file leaves only the Docker project-list summary available, with no service/config/image reads. `ps` and `images` use the absolute Compose path, explicit project directory and verified env file; when absent, `COMPOSE_DISABLE_ENV_FILE=true` disables default `.env` discovery while preserving explicitly inherited `COMPOSE_ENV_FILES` (ADR 0008 amendment).
- Draft validation uses the same environment context as a mutation: the draft `.env` when it is edited, otherwise the verified live `.env` explicitly, otherwise nothing. Validation and execution therefore cannot diverge through implicit discovery such as `COMPOSE_ENV_FILES`.
- Backup directories (`<root>/.compose-panel/backups/<stack>/`) are lstat-checked component by component: symlinks and non-directories are refused and created directories are owner-only. The stack directory identity (dev/ino) is revalidated after the validation window, so a swapped directory is a conflict even with identical content. These checks are point-in-time: they close the window to the commit instant but are not a transaction against a privileged local writer racing `rename` itself. The backup directory is likewise not re-validated between `ensureBackupDir` and the copy, so the same privileged-writer assumption covers that `ensure→copy` window.
- Every save first copies the previous file to `<root>/.compose-panel/backups/<stack>/`; if writing the second file of the pair fails, the first is restored and the failure is reported as partial with backup references, never as success. Files are re-read after validation, so an external change during the validation window is a conflict, not a silent overwrite. A save is a modifying operation and holds the per-stack lock.
- Backups hold old `.env` secrets. The newest `COMPOSE_PANEL_BACKUP_RETAIN` per file are kept and older ones deleted after each save; "Delete all backups" (`POST /stacks/<name>/backups/purge`) removes them at once. The purge requires session, allowed Origin and CSRF, holds the per-stack lock, and is recorded in the activity log. Only regular files with the exact backup name format are deleted, with `unlink` (never follows symlinks), after the same lstat checks as backup creation (ADR 0017).

## Operations (P4)
- Mutating actions are a fixed allow-list (`up`, `pull`, `stop`, `start`, `restart`, `down`, `pull-up`); there is no generic "run command" endpoint and no user-supplied option.
- `up` and `restart` accept one optional service (`action=up&service=web`): the name must pass the service syntax check and belong exactly to `config --services` discovery (no implicit profile activation), otherwise `400`/`503`/`409` before any mutation runs. Scoped `restart` is `restart --no-deps -- <service>`; scoped `up` is `up -d --no-deps -- <service>` with normal `Up` semantics (Compose may pull or build). Scoped `up` never creates a stack; a `service` field on any other action is refused, never ignored. The service is kept in the operation view and the activity log.
- "Update ready" uses two read-only calls with fixed arguments (`compose images`, `image inspect`); image references are validated and passed after `--`. Image labels are untrusted: only absolute http(s) URLs become links, all label text is HTML-escaped, and links open with `rel="noopener noreferrer"` ([ADR 0011](adr/0011-pull-and-update-ready.md)).
- Every operation runs through the provider with an explicit `--project-directory` and `-f`, plus `-p` when the project is known. The folder name is never assumed to be the project name.
- Compose subprocesses run with the `COMPOSE_PANEL_*` namespace stripped from the environment (see [ADR 0008](adr/0008-compose-subprocess-environment.md)), so the admin password hash and other panel settings cannot enter Compose interpolation even if a stack references them. Other operator variables still pass through by design.
- Mutations and log follows fail closed on the project context: ambiguous matches and unreachable Docker discovery refuse to act (`409`/`503`) instead of running without `-p`. An undeployed stack only allows creation (`up`, `pull-up`) and downloading its images (`pull`); destructive actions require a resolved project. Draft validation reuses the resolved `-p` identity when known.
- Before creation, Compose resolves the effective project name from the actual file and interpolation environment. Discovery is refreshed and a name already owned by another project is refused; creation pins the verified name with `-p`. Effective config is captured only inside the provider to extract that name and is never published or logged. Concurrent panel operations also reserve the project name, including across different stack directories. External CLI writers do not share this in-memory reservation: discovery remains a point-in-time check.
- Process timeouts and log aborts request `SIGTERM`, escalate to `SIGKILL` after 250 ms and stop waiting after 1 second. Linux spawns own a separate process group, so signals reach the Compose plugin child as well as the CLI parent. An unconfirmed exit or pipe cleanup is an unknown outcome; the stack/project lock remains held to prevent overlapping mutations. A stopped log follow similarly blocks replacement until its exit is confirmed. These guards are in memory and disappear on restart; verify the actual Docker state before retrying after a crash.
- One operation per stack, enforced by the same per-stack lock as saves; a second request is rejected with `409`. `up` is detached and the panel never attaches a terminal.
- Success is reported only after exit 0; a timeout is `unknown`; a second file/op state is never invented. Browser disconnect does not cancel an operation.
- On `SIGTERM`/`SIGINT`, new operations, saves and log follows are refused synchronously before anything is awaited, then running work drains under one shared deadline. There is no persistence and no automatic replay: after a crash the outcome may be unknown and the UI re-reads Docker.
- Operation output is captured from both streams and bounded; pipe chunks stream to observers while the command runs (retention stays head-capped with a truncation flag). Output is HTML-escaped before display and never written to application logs.

## Application toolbox (ADR 0026)

- The panel may execute only **explicitly declared, non-interactive application
  actions** inside a running stack service. There is still no arbitrary command
  execution and no interactive terminal, and the generic "run command" endpoint
  stays prohibited (see Operations above). The new capability is a closed,
  declared set of actions.
- Actions come only from a project's manifest (`extra["compose-panel"]` in
  `composer.json`, `"compose-panel"` in `package.json`), intersected with its
  `scripts`. The Compose `x-compose-panel.toolbox.sources` extension only names
  where to run and never authorizes an action. The manifest is trusted code: a
  deployment can change an action's behavior; the catalog revision records what
  ran, it does not guarantee immutability.
- The browser sends identifiers only. The backend resolves the action in the
  catalog, validates the name against a strict grammar that refuses option-like
  names (a leading `-`) for all runners, and never builds the argument array from
  the transmitted name.
- Discovery resolves exactly one running container per service (`compose ps
  --status running -q`) and reads the manifest from that container via
  `docker cp -- <id>:<path> -`, never by running the runner.
  The binary transfer is capped at `COMPOSE_PANEL_TOOLBOX_MAX_MANIFEST_BYTES`
  plus 16 KiB for tar metadata and padding, and killed on overflow. Exactly one
  named regular file is parsed in memory; nothing is extracted or written to
  disk. Links, directories, extra files and unsafe PAX overrides are refused
  ([ADR 0029](adr/0029-bounded-manifest-transfers.md)). Several running containers make the action unavailable (no
  `--index`, no fan-out).
- Execution acquires the per-stack lock before revalidating (container,
  manifest and revision are re-resolved under the lock), pins the same container
  id, and runs a fixed `docker exec` argument array with no shell, no TTY, no
  stdin and no `--privileged`; the optional `user`/`workdir` override the
  container defaults, and a supplied `workdir` must be absolute. Mutations stay
  authenticated, Origin- and CSRF-protected and recorded in the activity log
  (`toolbox`: action, source, container id, image id, catalog revision, exit
  code; never the output). Output is HTML-escaped before display and never
  written to application logs.
- Success is exit 0; a timeout is `unknown`. A confirmed termination releases
  the lock, but the action may still be running in the container; the panel does
  not claim it stopped the work. An under-lock revalidation mismatch (a changed
  declaration, project or catalog) ends the operation as `refused` with nothing
  executed, distinct from a failed run. The lock does not protect against
  external Docker writers, and the container is pinned so an action is never run
  on a container other than the one discovered.

## External database explorer link (ADR 0027)
- The panel builds an **external link** to a separately deployed explorer
  (LibreDB Studio, Adminer, pgAdmin…). It never contacts the explorer, reads no
  credential, opens no database and runs no Docker command for it. The link is
  inert until an administrator clicks it; the target is a separate system with
  its own authentication and access control. See
  [ADR 0027](adr/0027-external-database-explorer-links.md).
- The global `COMPOSE_PANEL_DATABASE_EXPLORER_URL` is administrator
  configuration, validated at startup like the access settings: http(s), https
  outside `COMPOSE_PANEL_DEV`, no credentials, path, query or fragment. V1
  targets an explorer served at the root of its domain. An invalid value is
  refused at startup; an empty value disables the feature.
- A stack declares the link in `x-compose-panel.database`, read from the raw
  Compose file and never re-serialized. Only a display `label` and a mapping of
  scalar `query` parameters are read, and only strings and booleans are accepted
  (a bare number is refused, since YAML would change its textual form). Nested
  mappings, lists and null values are refused, keys and values reject control
  characters and are length-bounded, and the number of parameters is capped. An
  invalid declaration is a **warning** on the stack page, never a `500`, and
  never blocks the stack's administration.
- The link is built with `new URL()`/`URLSearchParams` and rendered with
  `target="_blank" rel="noopener noreferrer"`; the label and every parameter are
  HTML-escaped. Parameters are public by construction (a connection id, a host,
  a database name): a **secret must never be placed in a query parameter**. The
  panel neither verifies nor stores the link, the parameters or the connection.
- The panel cannot create users, connections or secrets, and does not configure
  Docker networks or the explorer. The real protection against unwanted SQL is
  the target system's own authentication and its database-level grants; network
  isolation limits connectivity but is not a sandbox. The panel makes no
  assumption about any explorer-specific setting. See
  [the LibreDB deployment example](integrations/libredb.md).

## Caddy site management (ADR 0030)

- The privileged helper runs on the host as the `caddy` user, activated per
  request through a systemd socket mounted into the panel container. Its
  protocol is closed (`status`, `attach`, `detach` with four bounded fields):
  no free command, no user-supplied path, no shell. The managed directory and
  the main `Caddyfile` are fixed in the helper's own host-side configuration.
- Panel → helper calls carry one bounded JSON line each way with an explicit
  timeout. A helper that cannot be reached, answers too late, too large or
  malformed leaves an unknown outcome (`503` on mutation, a warning on the
  page), never a success.
- Caddy itself is always invoked with a fixed executable and explicit argument
  arrays (`validate`, `adapt`, `reload` with `--config`/`--adapter`), bounded
  output and timeouts. `caddy validate` alone is not trusted to prove the
  integration: the helper checks the `import` text in the main `Caddyfile`
  before publishing, and the adapted JSON for the expected route before
  reloading. A missing import refuses before anything is written.
- Ownership is enforced by a strict file header. Foreign files and externally
  modified managed files are refused, never overwritten or adopted. Repeating
  an identical attach is a no-op without reload; changing a mapping requires
  detach first.
- Concurrency: every attach/detach holds the panel's per-stack lock (so a
  self-update start refuses while one runs, and shutdown drains it) and the
  helper serializes the whole prepare → reload sequence behind an exclusive
  lock directory with stale-holder expiry. External writers can take the same
  lock path; otherwise coordination with them is best-effort and documented.
- Rollback is honest: a failed reload restores the previous file and reloads
  that; a second failure is reported as unknown requiring host intervention.
  Validation/adapt failures remove the unpublished candidate without any
  reload, since the running configuration was never touched.
- The panel verifies before calling: session, allowed Origin and CSRF on both
  endpoints, deployed project identity resolved fail-closed, service
  membership against `config --services`, and the port against the
  loopback-bound (`127.0.0.1`/`::1`) published ports of the service's running
  containers, read through the existing read-only inspector. The helper
  re-validates every field under its lock.
- The panel never fetches the domain (no SSRF surface by construction) and
  never stores or logs anything beyond the domain, stack, service and port —
  all bounded, all HTML-escaped, with `noopener noreferrer` on the
  application link. Audit events `caddy` (`attach`/`detach`, with stack,
  service and domain) record starts, refusals, failures and unknowns.
- `stack.managed-by` stays display-only: read-only routing for externally
  deployed stacks is a workflow refusal, not a trust signal, and it never
  disables the panel's other actions.

## Self-update
- `POST /about/check` (pull the panel's own tag) and `POST /about/update` (start the updater) require a session, an allowed Origin and the CSRF token, are refused during shutdown and are recorded in the activity log (`self-update-check`, `self-update`). See [ADR 0018](adr/0018-self-update.md).
- Nothing comes from the browser except the target image ID, which must be a `sha256:` ID equal to the image the tag points to when the request is handled. Project, service, paths, image reference, socket source, user and groups are read from Docker (`/proc/self/mountinfo`, then `container inspect` of the panel's own container) and validated: plain absolute paths without `..` or CSV-breaking characters, Compose and env files inside the deployment directory, a tag reference (not a digest or ID), a socket bind mount. Anything unexpected disables the feature with a reason.
- The updater is `docker container run` with fixed arguments: started from the image the panel already runs, `--network none`, the socket, the deployment directory read-only, and `bun src/scripts/self-update.ts` with validated arguments (re-validated by the updater). No shell. It gets the same Docker access the panel already has, so it adds no privilege. It only recreates the panel's own service, with `--no-deps --no-build --pull never`.
- **Release policy.** Only the official image (`ghcr.io/lekoala/compose-panel`) is offered, and its release source is a fixed GitHub repository, never an image label. An image is installable only if the release of its exact version label is published, not a draft or prerelease, at least 72 hours old (`published_at`), and records an index digest found in the image's `RepoDigests` under the official repository. The local image ID is never compared to the digest. GitHub unreachable, an unexpected answer or any mismatch refuses. The request is unauthenticated, bounded in time and size, refuses redirects, and is made only on Check and Install, never on page render. Install re-reads the release; the interface has no bypass.
- The release workflow writes the digest from `docker buildx build --metadata-file` (`containerimage.digest`) to the versioned registry before creating or editing the GitHub Release. Only the separate publication job has `contents: write`, and the build waits for CI on the tagged commit. Check and Install require the latest registry record to match the release digest and wait 72 hours from the later of publication and registration. Replacing a digest appends history and restarts the wait; retrying the same digest preserves its date. Both HTTP bodies are byte-counted while streaming, with cancellation on overflow and one shared deadline. The registry is reviewable Git history, not an independent trust authority ([ADR 0028](adr/0028-versioned-release-registry.md)).
- The updater refuses (nothing changed) when the tag no longer resolves to the approved image ID, when that image's `RepoDigests` lacks the release digest, when `compose config` resolves the service to another image, when an unrecorded `.env` would be read implicitly, or when the previous image cannot be tagged `compose-panel:rollback`. It never pulls or builds. Interpolated config never leaves the provider: only the service's image string is extracted. Updater labels (previous/target image IDs and versions) are validated when read back.
- One update at a time: the fixed container name, a running updater, a running stack action or save, any held stack lock (including one kept after an unconfirmed process exit, which a restart would otherwise drop), or shutdown all refuse a new one. Shutdown and the session are re-checked right before the updater starts. From the moment an update starts, actions, saves and backup purges are refused until Docker confirms the updater ended or never started; a start command that fails or times out is checked against Docker and reported as unknown (mutations still paused) when Docker cannot tell, never as "nothing changed".
- The updater's Docker and Compose subprocesses get `PATH`, `HOME` and (when set) `DOCKER_HOST` only, so the panel image's `ENV` cannot take precedence over the deployment's `--env-file` during interpolation.
- The outcome is read back from the finished updater container (`container inspect` and bounded `container logs` of the fixed name, only when it carries the panel's label). Output is HTML-escaped and never written to application logs. A same-named container without the label is never read or removed.

## Container inspection (read-only)
- A second boundary, `ContainerInspector`, exposes only `docker container ls`, `inspect` and `logs` through the fixed executable and explicit argument arrays (never a shell). IDs are validated (`^[0-9a-f]{12,64}$`) and passed after `--`; there is no start/stop/remove/exec and no user-supplied option. See [ADR 0014](adr/0014-docker-container-inspection.md).
- **Read-only is application-level.** Mounting the socket `:ro` does not restrict the Docker API; the guarantee is that the panel only ever builds the three read commands. A full compromise of the panel still has root-equivalent access through the socket, accepted for the single trusted administrator.
- The home "Other containers" section and `GET /containers` are behind authentication and `no-store`. Container listing reads a fixed `docker container ls` template (fields individually JSON-encoded, Compose labels read with `.Label`, never the `.Labels` string parsed as a dictionary); `HealthStatus` and `Status` are untrusted text and are HTML-escaped before display.
- **Managed classification is strict, never by name.** A container is Managed only when a `com.docker.compose.project.config_files` path maps to a discovered stack's canonical Compose file (through the optional `COMPOSE_PANEL_STACKS_PATH_ALIASES` host→panel prefix remap), or when `config_files` is absent and the `com.docker.compose.project` label matches exactly one deployed managed project. Renamed projects, unmappable or divergent paths (a Dockge migration), several files and stacks removed while their container still runs stay External Compose. Labels are declarative metadata, not a trust signal.
- Docker operations on these observed containers are refused by construction: the panel offers no lifecycle button and no arbitrary command. The detail page (`GET /containers/<id>`) reads a single `docker container inspect` and shows only a whitelisted projection (`src/container-state.ts`): `Config.Env`, `Args` and every unlisted field are dropped and the raw object is never retained, logged or returned. Mounts (host paths) are shown collapsed behind a `<details>`.
- `GET /containers/<id>/logs` is a bounded one-shot `docker container logs` (`--tail` restricted to an allow-list, output capped in bytes), authenticated and `no-store`, with ANSI stripped. Docker stderr is never echoed (logs may contain secrets) and only a fixed failure message is returned; the content is never written to application logs. There is no follow and no terminal.

## Engine and resource insights (read-only)
- The same `ContainerInspector` boundary adds `docker info`, `docker stats --no-stream` and `docker system df` through the fixed executable and explicit argument arrays, with no user-supplied option and no mutation ([ADR 0015](adr/0015-readonly-engine-insights.md)). `docker system df` walks Docker's storage and can be expensive, so it is read **on demand only** and served behind a short in-memory TTL cache (`COMPOSE_PANEL_DISK_USAGE_TTL_MS`); it is never part of a normal page load or a live refresh.
- `GET /server` (and its `?disk=1` on-demand read) is authenticated, `no-store` and read-only. `docker info` is projected onto a fixed field whitelist: the raw object may carry registry, proxy and environment configuration and is never retained, logged or returned. A malformed response is reported as unavailable, never as a fabricated zero, and a failing collection never turns into a `500`.
- The optional Live refresh polls `GET /server/stats` (authenticated, `no-store`, JSON) which reads only the container list and `docker stats` — never `docker info` and never `docker system df`. Polling is client-side, sequential, paused while the tab is hidden and stopped on `401`; the server starts no background collection.
- Stack aggregation reuses the strict ADR 0014 classification: external and standalone containers are visible but never added to a managed stack on a name resemblance. A stack's CPU is a cumulative figure that may exceed 100 %, network/block I/O are cumulative counters (not rates), and disk usage is Docker-managed storage only — not total host disk usage.

## Streaming (P5)
- Both event streams require an authenticated session and answer `401` (never a login redirect) without one. Stack names are validated exactly like reads; unknown stacks are `404`.
- Open streams are bound to their session id: logout closes them immediately, and each heartbeat closes a stream whose session has expired (the check does not refresh idle activity). The session is also re-checked synchronously just before subscribing, so a logout during the awaited Docker discovery cannot let a stream register. An operation observer disconnect still leaves the operation running; closing the last log reader still triggers the follow cleanup.
- Operation SSE is observation-only: subscribing never starts or cancels work, and disconnecting never stops a running operation. The `done` frame is sent only after a terminal state; the stream also ends on heartbeat timeout.
- Log follow spawns `compose logs --follow --tail N --timestamps` through the provider with an explicit argument array (no shell), one subprocess per (stack, service, tail) selection at most (two selections per stack). The subprocess is killed when the last reader leaves, when the explicit timeout fires, or on server shutdown. Readers share the process only with the identical selection; they never pass options. `?service=` is validated against `config --services` discovery (syntax, exact membership, no implicit profile activation) and passed after `--`; `?tail=` must be an offered count or the configured default applies.
- Bounds: process-wide subscriber cap (`503` past it), per-stack retained log buffer (tail-kept, flagged), heartbeat, explicit stream/follow timeouts, and slow readers are dropped instead of buffering unbounded output for them. ANSI color escapes are stripped before broadcast.
- The browser inserts stream text via `textContent` only. CSP allows same-origin scripts (`/app.js`) and same-origin EventSource connections; Docker logs may contain secrets and are therefore behind auth with `no-store`, like the Compose file.
- Pipe decoders preserve UTF-8 across reads. SSE output/chunk payloads carry JSON text fragments so carriage returns, newlines and partial lines survive framing and browser insertion exactly. Following an absent project returns an empty ended stream without spawning Compose.
- The one-shot log history (`GET /stacks/<name>/logs`) is authenticated like every read, resolves the same fail-closed project context as the follow, and is bounded by the Docker read timeout and output cap. It answers `text/plain` with `no-store`; Docker stderr is never echoed (logs may contain secrets), only a fixed failure message, and it never starts a follow subprocess.

## Audit trail (P7)
- An append-only activity log records sign-ins (success/failure/refusal), sign-outs, file-save outcomes, backup purges and operation starts/refusals as NDJSON, one file per day under `<stacksRoot>/.compose-panel/audit/` (override `COMPOSE_PANEL_AUDIT_DIR`), keeping the most recent `COMPOSE_PANEL_AUDIT_RETAIN_FILES` files. Lines never contain passwords, hashes, `.env` values or Compose output, nor the typed username (only whether it matched the admin account); fields are single-line and length-capped. Each period file is size-capped (`COMPOSE_PANEL_AUDIT_MAX_FILE_BYTES`, closed by one `suspended` marker) and sign-in refusals/failures are capped per minute with a `suppressed` summary line, so unauthenticated traffic cannot fill the disk.
- It is read-only in the UI (`/audit`) behind auth, `no-store` and HTML escaping. Reads are bounded to the tail of a single period; filenames are derived from a validated period, never from user input. The directory is created owner-only and a symlinked directory or log file is refused. In the default layout every component from the stacks root down (`.compose-panel`, `audit`) is lstat-checked for writes, reads and pruning, like backups; with `COMPOSE_PANEL_AUDIT_DIR` the configured folder itself is checked and its parents are trusted. Listing and retention only consider regular files named exactly `<period>.log`, so other files in the folder are never deleted. The same privileged-local-writer assumption as for backups covers the window between these checks and the file operation.
- Writes are best-effort and never fail the request that produced the event. The log is the operator's trail and the input for a host-level ban (fail2ban/CrowdSec), not an in-panel firewall.

## Proxy and TLS contract
- The bind is hard-coded to `127.0.0.1` and not configurable ([ADR 0010](adr/0010-reverse-proxy-mode.md)). Default access is direct loopback HTTP through an SSH tunnel.
- The `Host` header is validated before routing: only an enabled loopback authority (on `PORT`) or a configured proxy origin is accepted (`400` otherwise). This protects against DNS rebinding and proxy misrouting. `/health/live` is exempt so infrastructure probes with a service-name Host still work.
- A mutation whose `Origin`/`Referer` does not match the request's access point is refused. A sandboxed/embedded context (`Origin: null`) is refused by default; login answers a `303` back to `/login` with an explanation rather than a bare `403`. The opt-in `COMPOSE_PANEL_ALLOW_OPAQUE_ORIGIN` (default false, local testing only) accepts an absent/opaque Origin when Fetch Metadata reports `same-origin`/`none`; a cross-site frame is still refused. CSP `frame-ancestors 'none'` backs this up in the browser.
- Reverse-proxy access is a list, `COMPOSE_PANEL_PROXY_ORIGINS=https://a,https://b`, for TLS proxies on the same host ([ADR 0012](adr/0012-multiple-access-origins.md)). Each request is resolved to an access point from its Host — an enabled loopback authority or a configured origin — and Origin/Referer must match that same point; a request mixing the two paths is refused. Cookies are `Secure` on an https origin. The client address is the last `X-Forwarded-For` entry, read only on a proxy access point (on loopback it is ignored and the key is `direct`); `X-Forwarded-Proto` and vendor identity headers are ignored everywhere. With no origin configured, loopback is implicit; with origins, loopback needs `COMPOSE_PANEL_ALLOW_LOOPBACK=true`. Startup is refused for a plain-http origin outside development, for credentials, a path/query/fragment, empty entries or duplicates. `COMPOSE_PANEL_PUBLIC_ORIGIN` and `COMPOSE_PANEL_TRUST_PROXY` are refused (see [ADR 0012](adr/0012-multiple-access-origins.md)); the old single-origin and global-trust rules of ADR 0010 are superseded.
- **Trust boundary.** Host selects the configured access point but does not authenticate the proxy: the reverse proxy and an SSH tunnel both reach the loopback listener, and a client able to reach it can present a proxy-origin Host plus a forged `X-Forwarded-For`. This cannot bypass authentication or CSRF, but it can misattribute the throttle key and the audit `actor`. Accepted for the one-admin threat model; isolating proxy trust would need separate sockets or an authenticated proxy. Only the last `X-Forwarded-For` entry is read; vendor identity headers (`CF-Connecting-IP` and the like) are ignored, and behind a multi-hop chain that last entry is the last proxy, not necessarily the visitor.
- **Identity proxies are not trusted for authentication.** A front end such as Cloudflare Access may verify a user before forwarding, but the panel still requires its own password, session and CSRF token and never authorizes on a Cloudflare or identity header. Publishing such a route without its access policy in force exposes the panel publicly; see [Behind Cloudflare Access + Tunnel](deployment.md#behind-cloudflare-access--tunnel-identity-proxy).
- Supported and tested proxy: Caddy (`scripts/proxy-e2e/run.sh`, real Caddy with TLS, two origins plus the coexisting loopback path). Recommended second barrier in front: VPN, IP allow-list or proxy authentication, plus a host-level ban on the activity log.

## Minimum before remote/production use
- Auth mono-admin (secret provisioned outside repo, robust password derivation, cookies HttpOnly, Secure, SameSite, rotation de session après login, logout). *(implemented in P1)*
- CSRF on all POSTs and strict Origin/Host checks, behind an explicitly configured proxy. *(implemented; verified behind a real Caddy with TLS by `scripts/proxy-e2e/run.sh`, ADR 0010)*
- TLS via proxy, bind on a private interface, firewall/administration network. Never expose the Docker socket over TCP.
- Limit file sizes, execution time, log/SSE size, login attempts. *(login attempts, request body size, edit sizes, Docker/operation caps, SSE subscribers/heartbeat/timeout and log tail/buffer/timeout implemented in P1–P5; login is throttled by a bounded delay with no hard per-client lockout, and the activity log is bounded by retention and read caps in P7)*
- Escape HTML, restrictive CSP, disable caching of sensitive pages, protect any response containing `.env`.
- Ensure safe resolution of names and files: name allow-list, reject symlinks, protect the root path, no absolute paths supplied by the user.
- Subprocesses via argument arrays, no shell. No freely user-supplied options. No generic Docker command. *(read-only `compose ls`/`ps` implemented in P2 with a fixed executable, timeouts and output caps; mutations arrive in P4)*
- Backups before modifications, controlled concurrency, operation limits and graceful shutdown. *(backup, per-stack lock, optimistic concurrency and the operations manager implemented in P3–P4; shutdown drains running operations)*
- Docker logs may themselves contain secrets. Never include them in unprotected application logs.

## Mandatory security checks
Tests for `../` paths, encoded URLs, trailing-newline/NUL/double-encoded names, missing STACKS_DIR (fail-closed 503, no Docker call), non-conforming names, symlinks, double Compose, `.env` symlink (editor, mutation and follow), write conflicts, login burst, delay growth and the no-lockout guarantee, session-revocation stream close, unexpected Host rejection, `.env` redaction with comments/quotes and boundary truncation, secrets in errors, CSRF, XSS, concurrent operations, malformed Docker CLI output, timeout/output-cap handling, read-only insights (`docker info` whitelist projection with no registry/proxy/env leak, and unavailable-vs-zero handling), SSE auth/subscriber limits/slow readers, log follow kill-on-last-reader/timeout, audit rotation/retention/read-cap/symlink refusal and no-secret logging, self-update (release policy: 72-hour age from both `published_at` and digest registration, registry mismatch/replacement/idempotent retry refusal rules, streamed response byte caps, draft/prerelease/tag refusal, index digest required in `RepoDigests` under the official repository, GitHub unreachable or unexpected answers refused, fixed release URL without redirects, re-check on install, no GitHub call on render; own-identity validation refusing `..`, relative or CSV-breaking paths, files outside the deployment, digest-pinned or locally built images and a missing socket mount; fail-closed when Docker cannot describe the panel or its image; fixed updater arguments without shell; strict updater argv parsing; refusal of a stale target, a missing release digest, an untaggable rollback image, a changed Compose image or an unrecorded `.env` with nothing recreated; CSRF/Origin/session on both endpoints; refusal during running actions and pause of mutations while updating; never touching a same-named foreign container; escaped updater output; recovery commands quoted), Linux shutdown/restart and stuck processes, dependency audit (`bun audit` on every CI build plus the Trivy image scan).

## CI
Subprocess tests only in a disposable/isolated Docker daemon. Never mount the CI host's production engine socket in automated tests.
