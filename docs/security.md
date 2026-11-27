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
A curated recipe is only pre-filled text in that same form: the panel generates
no secret, allocates no port, attaches no domain and starts nothing when a
recipe is opened, and the submission passes through exactly the checks above
([ADR 0058](adr/0058-curated-compose-recipes.md)).

Deployment metadata is authenticated and `no-store` like the stack detail.
Resolved Compose config is projected inside the provider onto an explicit
label allow-list; other labels, environment and stderr are never returned.
All metadata is bounded and escaped. Links allow HTTP(S) without credentials,
open with `noopener noreferrer`, and are never fetched by the panel.
`stack.managed-by` is display-only: it never disables an action, changes
authorization or counts as proof of who deployed the stack (ADR 0025).

An administrator able to edit and then deploy a Compose file on a rootful Docker daemon can obtain very high control over the host. This panel is **not** a Docker sandbox, nor a multi-tenant API. Trusted users only.

## Delivered entry protections (P1)
- The HTTP socket idle deadline is explicitly 60 seconds, allowing the default
  bounded diagnostics chain to finish or return its timeout warning. Docker
  command deadlines and output limits remain independent and unchanged.
- The production HTTP listener explicitly disables Bun development errors; uncaught request errors return a generic, non-cacheable text 500 without the thrown value in the response or fallback log. The image sets `NODE_ENV=production`.
- Local loopback `127.0.0.1` only, no exposed bind. A single administrator authenticates; the password is stored only as an Argon2id hash (`Bun.password`) supplied outside the repo.
- Common/guessable administrator usernames (`admin`, `administrator`, `root`, `user`, `test`, `guest`) are refused at startup unless `COMPOSE_PANEL_DEV=true` (local development only). A unique `COMPOSE_PANEL_ADMIN_USER` is required.
- Sessions are random server-side identifiers kept in memory (lost on restart). Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` on an https proxy origin or when `COMPOSE_PANEL_COOKIE_SECURE=true` (the direct/loopback path); the session id rotates on login.
- All mutating requests (login, logout) require a matching CSRF token and an exact Origin/Referer match. The login page uses a double-submit CSRF cookie: a well-formed token already in `cp_csrf` is reused so several sign-in tabs share one form token, and only a missing or malformed value is replaced ([ADR 0055](adr/0055-login-csrf-across-tabs.md)). Authenticated pages use a per-session token.
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
- "Recreate pending" (ADR 0032) adds `config --hash "*"` in that same read context. stdout is accepted only as `<service> <64 hex>` lines and anything else discards the whole answer; stderr, which may echo interpolated values, is never read. From `container inspect` only the Compose service and config-hash labels and four `HostConfig` namespace/volume fields are parsed.
- Draft validation uses the same environment context as a mutation: the draft `.env` when it is edited, otherwise the verified live `.env` explicitly, otherwise nothing. Validation and execution therefore cannot diverge through implicit discovery such as `COMPOSE_ENV_FILES`.
- Backup directories (`<root>/.compose-panel/backups/<stack>/`) are lstat-checked component by component: symlinks and non-directories are refused and created directories are owner-only. The stack directory identity (dev/ino) is revalidated after the validation window, so a swapped directory is a conflict even with identical content. These checks are point-in-time: they close the window to the commit instant but are not a transaction against a privileged local writer racing `rename` itself. The backup directory is likewise not re-validated between `ensureBackupDir` and the copy, so the same privileged-writer assumption covers that `ensure→copy` window.
- Every save first copies the previous file to `<root>/.compose-panel/backups/<stack>/`; if writing the second file of the pair fails, the first is restored and the failure is reported as partial with backup references, never as success. Files are re-read after validation, so an external change during the validation window is a conflict, not a silent overwrite. A save is a modifying operation and holds the per-stack lock.
- Backups hold old `.env` secrets. The newest `COMPOSE_PANEL_BACKUP_RETAIN` per file are kept and older ones deleted after each save; "Delete all backups" (`POST /stacks/<name>/backups/purge`) removes them at once. The purge requires session, allowed Origin and CSRF, holds the per-stack lock, and is recorded in the activity log. Only regular files with the exact backup name format are deleted, with `unlink` (never follows symlinks), after the same lstat checks as backup creation (ADR 0017).

## Operations (P4)
- Mutating actions are a fixed allow-list (`up`, `pull`, `stop`, `start`, `restart`, `down`, `pull-up`); there is no generic "run command" endpoint and no user-supplied option.
- `up` and `restart` accept one optional service (`action=up&service=web`): the name must pass the service syntax check and belong exactly to `config --services` discovery (no implicit profile activation), otherwise `400`/`503`/`409` before any mutation runs. Scoped `restart` is `restart --no-deps -- <service>`; scoped `up` is `up -d --no-deps -- <service>` with normal `Up` semantics (Compose may pull or build). Scoped `up` never creates a stack; a `service` field on any other action is refused, never ignored. The service is kept in the operation view and the activity log.
- "Update ready" uses two read-only calls with fixed arguments (`compose images`, `image inspect`); image references are validated and passed after `--`. Image labels are untrusted: only absolute http(s) URLs become links, all label text is HTML-escaped, and links open with `rel="noopener noreferrer"` ([ADR 0011](adr/0011-pull-and-update-ready.md)).
- The remote image check (`POST /stacks/<name>/image-check`, ADR 0041) requires session, allowed Origin and CSRF, and is audited (`image-check`). It is read-only but adds one outbound capability: `docker buildx imagetools inspect --format '{{json .Manifest}}'` on an already validated reference, one check at a time for the whole panel, bounded by a 30-second budget and a capped output, parsed into a single digest. Raw registry output is never rendered or logged; a failure becomes one classified `unknown` reason. Registry credentials stay in the Docker CLI's own `DOCKER_CONFIG` (none is stored by the panel); Buildx state and its lock go to a writable `BUILDX_CONFIG`, which defaults to an ephemeral panel-owned directory and is never written into `DOCKER_CONFIG`. Any started mutation drops every stored verdict (the image store is shared by all stacks), a stale or in-flight result is discarded instead of published, and no image is downloaded.
- Every operation runs through the provider with an explicit `--project-directory` and `-f`, plus `-p` when the project is known. The folder name is never assumed to be the project name.
- Compose subprocesses run with the `COMPOSE_PANEL_*` namespace stripped from the environment (see [ADR 0008](adr/0008-compose-subprocess-environment.md)), so the admin password hash and other panel settings cannot enter Compose interpolation even if a stack references them. Other operator variables still pass through by design.
- Mutations and log follows fail closed on the project context: ambiguous matches and unreachable Docker discovery refuse to act (`409`/`503`) instead of running without `-p`. An undeployed stack only allows creation (`up`, `pull-up`) and downloading its images (`pull`); destructive actions require a resolved project. Draft validation reuses the resolved `-p` identity when known.
- Before creation, Compose resolves the effective project name from the actual file and interpolation environment. Discovery is refreshed and a name already owned by another project is refused; creation pins the verified name with `-p`. Effective config is captured only inside the provider to extract that name and is never published or logged. Concurrent panel operations also reserve the project name, including across different stack directories. External CLI writers do not share this in-memory reservation: discovery remains a point-in-time check.
- Process timeouts and log aborts request `SIGTERM`, escalate to `SIGKILL` after 250 ms and stop waiting after 1 second. Linux spawns own a separate process group, so signals reach the Compose plugin child as well as the CLI parent. An unconfirmed exit or pipe cleanup is an unknown outcome; the stack/project lock remains held to prevent overlapping mutations. A stopped log follow similarly blocks replacement until its exit is confirmed. These guards are in memory and disappear on restart; verify the actual Docker state before retrying after a crash.
- One operation per stack, enforced by the same per-stack lock as saves; a second request is rejected with `409`. `up` is detached and the panel never attaches a terminal.
- Success is reported only after exit 0; a timeout is `unknown`; a second file/op state is never invented. Browser disconnect does not cancel an operation.
- On `SIGTERM`/`SIGINT`, new operations, saves, image checks and log follows are refused synchronously before anything is awaited, then running work drains under one shared deadline. There is no persistence and no automatic replay: after a crash the outcome may be unknown and the UI re-reads Docker.
- Operation output is captured from both streams and bounded; pipe chunks stream to observers while the command runs (retention stays head-capped with a truncation flag). Output is HTML-escaped before display and never written to application logs.

## Service rollout (ADR 0035)
- The route exists only with `COMPOSE_PANEL_ROLLOUT_ENABLED=true` **and** a
  valid `panel.rollout.enabled: "true"` declaration on the service. The backend
  refuses a service that is not declared, even if the form is forged.
- Every mutation reuses the existing guards: session re-check after awaited
  Docker reads, Origin, CSRF, per-stack lock, shutdown/self-update refusal and
  audit (`event: "rollout"`). One rollout per stack; a second request is `409`.
- The Compose facts come from the resolved config through the provider, which
  projects only the allow-listed fields and `panel.rollout.*` labels. Raw config
  and stderr are never retained or shown.
- A new `ContainerMutator` boundary owns three explicit calls: `stop --time`,
  `remove` (no `--force`, no `-v`) and `exec <id> touch <path>`. IDs must be full
  64-hex IDs from `container inspect`; the drain command is always `touch` and
  the path is validated (absolute, no `..`, no control characters, bounded).
  `ContainerInspector` remains read-only.
- Cleanup before drainage is allowed only after proving the candidate's
  identity: full ID, the four Compose labels, a creation date after the
  operation started and absence from the initial snapshot. Any ambiguity means
  no deletion. At the first drain attempt the operation becomes irreversible:
  failures keep the candidate and report an intervention; no automatic rollback,
  no marker removal.
- A command whose exit cannot be confirmed is `unknown` and keeps the lock. A
  crash leaves the outcome unknown; nothing is persisted or replayed.
- The rollout requires a healthcheck, one existing container, no published
  ports, no fixed container name, no local build and no shared namespace or
  volumes. A drain marker on a mount is refused. A reverse proxy that removes
  unhealthy instances is an operational prerequisite.
- The existing Caddy site integration attaches a published loopback port and is
  **not** compatible with rollout; this is documented in the UI and the
  deployment guide.
- Integration tests run on a disposable lab daemon, never on a host or in
  unattended CI.

## Managed-site creation (ADR 0042)
- `/new-site`, `/new-site/preview` and `/new-site` exist only with the flag.
  The authenticated form sends bounded identifiers: folder name, site ID,
  project, a port in 41000–41999, a channel id, a Git URL/ref and declared paths
  below `shared/`. It never sends a command, an image, a host path or an option.
  Preview is write-free; creation re-validates server-side instead of trusting
  the preview.
- `src/managed-site-generate.ts` fixes the two service names, the gateway image
  and the runtime image per channel. The generated Compose file is validated in
  a hidden `.cp-site-<random>` draft through `ComposeProvider`; the project must
  be unknown to Docker. The complete tree is published with one rename, so the
  final folder is never a half-managed ordinary stack that an action or raw save
  could select. No image is pulled and no container is started.
- Before writing, the panel refuses a port already declared by another managed
  site or published by any running container. Docker enforces the bind at start;
  an unrelated host listener remains outside the panel's knowledge.
- `POST /stacks/<name>/baseline` publishes the first release under the stack
  lock and operation view. It refuses when `current` already exists, re-checks
  the effective project and profile, refuses while Docker reports a running (or
  unprovable) service, stops and recreates nothing, and fetches with the same
  bounded Git adapter. Up, Start, Restart and Pull + up are refused for a
  managed site until a baseline is provable. A failure leaves the site without a
  pointer and can be retried; it is not a deployment.
- For `owner: managed`, the operation admission hook (under the stack lock)
  re-renders `compose.yaml` and `generated/*` and compares them byte-for-byte
  with disk. Drift refuses every Compose action, deploy, baseline, rollout and
  app action, naming the affected file. Reads and writes anchor `generated/`
  with a no-follow directory handle, so a symlinked folder cannot redirect them.
  Raw save is refused for a managed site and whenever a manifest exists but
  cannot be used; a valid `opt-in` stack keeps its editor. `POST
  /stacks/<name>/regenerate` is the only explicit repair: it takes the lock,
  refuses a pending deploy, renders again and replaces only those files
  atomically while preserving mode and owner. Before a gateway-port change it
  re-checks the reserved port and refuses while a Caddy domain still routes to
  the site. It never touches a release, the pointer or a container.
- Down is refused while a Caddy domain is attached (or when the helper cannot
  prove there is none), so a live route is not left pointing at a removed
  loopback port.
- Declared persistent roots resolve to `<stack>/site/shared/...` through the
  same helper as the profile check and are mounted into PHP only. The panel
  creates the directory but never chowns it: the operator prepares write access
  for the runtime image's UID (ADR 0042).

## Managed-site deploy (ADR 0042, ADR 0043)
- The deploy route exists only with `COMPOSE_PANEL_MANAGED_SITES_ENABLED=true`
  **and** a valid manifest. The browser sends identifiers only: no URL, ref,
  path, image or option comes from a request. The manifest is trusted operator
  configuration, read as a bounded regular file, and never rendered without
  escaping or logged.
- Every call reuses the existing guards: session re-check after awaited Docker
  reads, Origin, CSRF, one modifying operation per stack, project reservation,
  shutdown/self-update refusal and audit (`event: "deploy"`, including site ID,
  attempt ID, SHA and outcome, never output or file content). A second stack is
  never touched: every provider call carries an explicit project, directory and
  file.
- The effective Compose project is resolved **before** `-p` is injected; the
  manifest is re-read under the lock; the profile check inspects every service
  (parent binds, release aliases, `tmpfs`, `volumes_from`, non-canonical paths,
  external networks, shared project network). Any drift refuses before a fetch
  and before a stop.
- The runtime image reference must still resolve to the local image ID of the
  running runtime container, both before the fetch and again immediately before
  each forced recreation. `--pull never` only prevents a download: a recreation
  could otherwise apply a different already-present image under the same tag.
  That drift refuses instead of changing the rollback target.
- The baseline is mandatory: `current`, its completed metadata, its revision
  script and the fixed probe must agree on one full SHA before the first stop.
  There is no first deploy without a rollback target in the pilot.
- `src/git-release.ts` runs a fixed `git` executable with an explicit argument
  array, never a shell, and an environment built from an allow-list: no
  inherited system/global config, hooks, credential helper, askpass, terminal
  prompt, redirects or protocols beyond the selected transport. The fetch is depth-1 and
  non-recursive; time, output, files and bytes are bounded. The transfer itself
  is capped: the Git object store is polled while the fetch runs and the process
  group is aborted when the downloaded bytes exceed the limit. A free-space
  preflight runs before the fetch and again before the checkout with the exact
  tree size. The checkout is content: it is never executed, sourced, mounted
  into the panel or read as Compose/env input. Symlinks, gitlinks/submodules,
  `.git` entries and a repository-supplied `.compose-panel` are refused.
  Publication is one rename into an immutable release; only the attempt's own
  staging directory is removed, after comparing the inode created by the
  attempt. An unconfirmed process keeps the staging directory for inspection.
- Private Git ([ADR 0047](adr/0047-private-git-over-ssh.md)) requires an
  operator-provisioned, repository-scoped read-only key and independently
  pinned host key in `site/private/ssh`. Only the fetch receives the fixed SSH
  wrapper and SSH transport. The files and private directories are checked
  for ownership, permissions and links before use. OpenSSH uses batch public
  key authentication, strict host key checking, no inherited config or agent
  and no forwarding. Credentials stay outside the checkout and all service
  mounts. SSH fetch output is excluded from the operation view and audit.
- The optional Composer preparation ([ADR 0045](adr/0045-disposable-composer-preparation.md))
  runs two disposable containers per attempt with the digest-pinned
  `composer:2.10.3` image (the first 2.10 release fixing CVE-2026-59944). The
  first is an offline, read-only `composer validate` with `--network none`; the
  second is the install. Both use `--read-only`, `--cap-drop ALL`,
  `no-new-privileges` and bounded memory, CPU, PIDs, time and output. The
  install runs as the staging-tree owner; because the supported installer
  deployment runs the panel as root, that is uid 0, so the isolation is the
  dropped capabilities and the mounts, not an unprivileged Unix user.
  The install mounts only the staging tree; `COMPOSER_HOME` and the cache live
  on a bounded tmpfs and never touch the release filesystem. It receives no
  Docker socket, panel environment, secret file, production mount or database.
  `--no-scripts --no-plugins` keeps repository code from executing;
  `COMPOSER_BIN_COMPAT=proxy` avoids symlinks in the release. The repository
  must commit `composer.lock`, must not commit `vendor/`, and both
  `composer.json` and the lock's `platform-overrides.php` must match the site's
  PHP channel, because `composer install` verifies the lock against the lock's
  overrides, not `composer.json`. A stale lock is refused by the offline check,
  not accepted with a warning. A 250 ms byte and file-count monitor aborts a
  runaway install, and the post-build inspection enforces the exact cap. A
  failure removes only the attempt; if a container removal cannot be proven,
  the attempt is kept and the operation reports an unknown outcome. SIGTERM
  aborts the build before the operation drain and the cleanup fits inside the
  shutdown grace. Registry credentials and private packages are out of scope.
  The container reaches package registries through the daemon's default bridge:
  a host that needs stricter egress must constrain the daemon or provide a
  proxy, since the panel does not manage networks.
- The probe is one bounded `GET http://127.0.0.1:<published>/.compose-panel/revision`
  with no redirects, no DNS and no TLS; it must answer HTTP 200 with exactly 40
  lowercase hex characters and one newline. The port is the validated loopback
  binding of the gateway container, never a request value.
- The pointer switch is one rename. The runtime is always force-recreated after
  a switch; the gateway container must keep its identity, the runtime container
  ID must change, and its image ID must still be the running one. The gateway
  must resolve the runtime through Docker DNS at request time, so the new IP is
  reached without recreating the gateway. A failed probe
  rolls back only when service identity and process state are certain, and the
  rollback repeats the whole activation sequence: stop and confirm the gateway,
  switch the pointer, recreate the runtime, start the gateway and probe. The
  same container and image checks apply after the rollback recreation, and the
  rollback is probed before it is reported.
- From the first stop attempt, the attempt marker is kept until the gateway is
  running again and the probe confirms the release it must serve. A failure
  before the switch restarts the gateway and proves the baseline before a plain
  failure is reported; otherwise the result is an intervention. An exception
  after the stop follows the same rule and never clears the marker while the
  site may be down.
- An unconfirmed command is `unknown` and keeps the lock. A crash may leave a
  staging directory, a release, a switched pointer or an attempt marker. The
  marker is checked again under the stack lock before every modifying operation,
  so a request that passed an earlier check cannot slip in after an incident.
  The acknowledgement takes the same lock, re-reads the marker and is bound to
  the attempt ID the page displayed; a mismatch refuses. Nothing is resumed,
  replayed or retried.
- The disposable two-commit deployment suite on its own daemon is the
  integration gate; it never runs against a host daemon or in unattended CI.

## Existing database attachment (ADR 0048)

- A manifest v2 may declare one `existing` database (`mariadb`, `mysql` or
  `postgresql`) and exactly one external Compose network. The panel validates
  the declaration and the effective network membership; it never opens a
  database connection, runs SQL, provisions a database, reads a credential or
  adds a database client to its image.
- Only the runtime service may join the declared external network; the gateway
  and every other service stay on the project network. The panel refuses any
  other external network, a missing runtime membership and the gateway on the
  database network. The site's own project network remains the isolation
  boundary. Tenant isolation is the database's grants, not Compose, and the
  panel does not claim to verify it.
- For `owner: managed`, the generated Compose references the fixed private file
  `<stack>/site/private/database.env` with `required: false`, so Compose can
  validate the project before the operator provisions the file. Up, Pull + up,
  Start, Restart, Rollout and Deploy refuse until the file is a regular `0600`
  file owned by the panel account, at most 64 KiB. The panel checks metadata only: it never
  reads, parses, logs or renders the file values, and `docker compose config`
  output is treated as sensitive exactly like `.env`.
- The env file is outside every service mount and the generated/release trees;
  Compose reads it at container creation. An opt-in stack may use any credential
  mechanism for its own database, but the panel still validates the declared
  external network and the same port/network rules.
- A missing or failed database connection is an application failure. It does
  not roll back the release, and no automatic retry, migration or replay is
  added. Dumps, restores, migrations and backup credentials stay out of this
  attachment ([ADR 0048](adr/0048-existing-database-attachment.md)).

## Offsite backup (ADR 0049)

- **Back up now** is an authenticated, CSRF-protected mutation that holds the
  same per-stack lock as a deploy. A pending deploy or backup marker refuses it;
  backup does not depend on generated-file drift, because data recovery must
  remain possible while the code view is drifted.
- The manifest declares one `rest:https://` repository (or `rest:http://` only
  for a loopback or single-label private host) and, optionally, one bounded
  MariaDB database name. No credential, host path, command or free text is
  accepted in the manifest.
- Fixed private files live under `site/private/backup/`: `restic-password`
  (required), `rest.env` (optional) and `database.cnf` (required only for SQL).
  Each must be a regular `0600` file, one link, at most 4 KiB, owned by the panel
  account, inside a `0700` directory outside releases, generated files and every
  service mount. The panel checks metadata only and never reads, logs or renders
  a value. `database.cnf` is the MariaDB client's option-file format; it reaches
  the dump through `--defaults-extra-file`, so no secret is placed in argv.
- The staging copy walks only the declared persistent roots with no-follow
  semantics, revalidates device/inode while reading, refuses symlinks, hard
  links, special files, escape and overlapping roots, and stops at the entry and
  byte quotas. Inventory checksums are recorded in `backup.json`.
- The dump runs a pinned `mariadb-dump` container on the declared database
  network with the backup credential option file and one explicit database name;
  it cannot select all databases, run a statement or use a shell. The upload runs
  a pinned Restic container read-only against the staging tree and accepts only
  the exact snapshot id that `restic snapshots` and `restic ls` read back with
  the site tag and `/backup/backup.json`.
- A timeout or an unverifiable upload keeps a failed marker and refuses the next
  run until the operator acknowledges it after inspecting the repository. There
  is no automatic replay, no scheduler and no snapshot deletion from the panel;
  retention uses a separate offsite credential.
- The panel image gains no Restic or database client: both are one-shot
  containers. No Docker socket, privileged mode, host network or published port
  is used, and every invocation is a fixed executable with an explicit argument
  array.

### Verified restore

- **Verify and restore** is authenticated and CSRF-protected, takes the stack
  lock and is read-only against the live site. It accepts only one exact
  64-character snapshot id; `latest` and malformed values are refused.
- Before extraction, the panel checks that the repository returns that exact
  snapshot for this site, reads `backup.json` from the snapshot, and refuses a
  foreign site, an unsupported schema, a changed SQL database/engine, an
  inventory outside the entry/byte bounds, or any path not below `files/`.
- Restic extracts into a new `0700` directory under
  `site/private/backup/restore/<attemptId>/`. The tree is then read with
  no-follow semantics and every file must match its recorded size and SHA-256;
  links, special files, extra files and missing files refuse the restore.
  Nothing is written over `shared/`, a release or the current pointer.
- A SQL snapshot is imported into a fresh MariaDB container on a new internal
  network with an empty root password: no production credentials, no production
  network, no published port and no site volume. The import and one table-count
  query are fixed; the container and network are removed afterwards. A failed
  component is reported and the private restore directory is kept for
  inspection.
- The panel never promotes a restored copy into the live site. That remains an
  operator procedure, because it is a destructive mutation with its own failure
  boundary.

## CI-triggered deploy (ADR 0050)

- `POST /api/managed-sites/<stack>/deploy` is not a browser mutation: it accepts
  no session cookie and no ambient credential. It requires an explicit
  `Authorization: Bearer` token and `Content-Type: application/json`. CSRF is
  not applicable because a cross-site form cannot set that header or content
  type, and the panel enables no CORS. Every browser mutation keeps its Origin,
  CSRF and session checks.
- The panel stores only a verifier, never a usable token: a fixed
  `site/private/ci/deploy-token.sha256` regular `0600` file inside a `0700`
  directory, one link, at most 256 bytes, holding one lowercase SHA-256 digest.
  The fixed metadata is checked before the digest is read, the read is
  no-follow, and the comparison is constant-time. A missing or malformed
  verifier makes every machine request `401`; the site page shows why.
- The request body is bounded to 8 KiB and must contain exactly one 40-hex
  commit, the configured ref, a 16-64 character nonce and an ISO timestamp
  within 300 seconds of the panel clock. A nonce is consumed once and stored in
  a durable bounded record, so a captured request cannot be replayed. Ten failed
  authentications per site in 60 seconds answer `429`.
- The locked closure re-reads the manifest and re-checks the digest, nonce,
  deploy marker and backup marker before starting the existing deploy. After the
  Git fetch, the ref tip must equal the requested commit; a moved branch is
  refused before any container is stopped. A crash keeps the normal attempt
  marker and never authorizes a second deploy.
- The token is never logged, never returned, never stored by the panel and never
  placed in a URL. The endpoint stays on the loopback listener or the reviewed
  TLS proxy; the CI stores the token as a secret. Revocation is deleting the
  verifier or removing the `ci` block.

## Timer-triggered backup (ADR 0051)

- `POST /api/managed-sites/<stack>/backup` follows the same machine-endpoint
  rule: an explicit `Authorization: Bearer` token and `Content-Type:
  application/json`, no session cookie, no CORS. It is a separate credential and
  a separate verifier file, so a leaked deploy token cannot export data and a
  leaked backup token cannot deploy.
- The verifier is the fixed `site/private/backup/trigger-token.sha256` regular
  `0600` file, one link, at most 256 bytes, inside the `0700` backup credential
  directory, holding one lowercase SHA-256 digest. Metadata is checked before the
  digest is read, the read is no-follow and the comparison is constant-time.
- The request body is bounded to 8 KiB and must contain exactly a 16-64
  character nonce and an ISO timestamp within 300 seconds. A deploy-shaped body
  (a `sha`, a `ref`, a repository) is refused rather than ignored: the manifest
  always owns the repository, the roots and the SQL scope. A nonce is consumed
  once in the durable facts record, and repeated failures answer `429`.
- The locked closure re-reads the manifest and re-checks the digest, nonce,
  deploy marker and backup marker before starting the existing backup. A crash
  keeps the normal backup attempt marker and never authorizes a second backup.
- The durable `site/private/backup/trigger-state.json` (`0600`, bounded, atomic)
  holds only a coarse last attempt, the last good snapshot id, the last verified
  restore snapshot id and consumed nonces. It is a display and diagnosis fact,
  never a recovery journal, and it contains no credential.
- The token is never logged, returned, stored or placed in a URL. Revocation is
  deleting the verifier or removing `backup.trigger`. The host timer, not the
  panel, owns the schedule; overdue is computed from the durable fact.

## Retention preview (ADR 0052)

- `POST /stacks/<stack>/backup/retention` is an ordinary browser mutation: it
  requires an active session, the Origin check and the CSRF token, and it is
  unavailable when managed sites are disabled. It takes no token and adds no
  machine route.
- The preview is read-only. The panel runs the pinned Restic image in two
  one-shot containers, one per command, with a read-only root filesystem, a
  bounded tmpfs and the operator-owned password file. The commands are
  `snapshots --json` and `forget --dry-run --json` with the declared `keep-*`
  counts. `--prune` is never passed, no snapshot id is passed, and the panel
  holds no deletion credential. `--no-lock` is used because an append-only
  repository must not accumulate lock objects the panel cannot remove; the stack
  lock already serializes panel operations.
- The declared policy is forwarded unchanged. The panel reimplements no calendar
  rule, so the preview cannot diverge from the Restic invocation the maintenance
  host will use.
- The reply is bounded and cross-checked: every listed snapshot must carry this
  site's tag, appear exactly once in the union of `keep` and `remove`, and have
  a valid id and timestamp. A partial, duplicate, foreign or unfamiliar answer
  fails the operation instead of showing a removal set.
- If the removal set contains the recorded last good snapshot or the last
  verified restore snapshot, the operation warns. That warning is the only
  protection: the panel never rewrites the facts and never blocks the operator
  from changing the declared policy.
- The preview is operation output only. Nothing durable is written and only the
  snapshot ids and timestamps Restic returned are shown; no path, tag list,
  repository URL or credential appears. The audit line records the keep/remove
  counts, never an id or a policy reason.

## Snapshot inventory (ADR 0053)

- `GET /stacks/<stack>/backup/snapshots` is an authenticated read-only page and
  is unavailable when managed sites are disabled. It carries no CSRF token
  because it changes no state; the Host allow-list, the session check and the
  `no-store` response headers still apply.
- The page reuses the retention inventory call: one pinned Restic
  `snapshots --json --no-lock --tag site:<siteId>` with a read-only root
  filesystem, a bounded tmpfs and the operator-owned password file. It passes no
  snapshot id, no `forget`, no `prune` and no deletion credential, and it does
  not take the stack lock because it mutates nothing.
- The reply is bounded and parsed by the same all-or-nothing rules as the
  preview. Only 64-hex ids and RFC 3339 timestamps carrying this site's tag are
  rendered, newest first; a malformed, duplicated, foreign or oversized reply
  fails the page with no partial list. Paths, tags, hostnames, sizes, the
  repository URL and raw JSON are not rendered, and nothing is stored or cached.
- A pending deploy or backup marker, a missing backup block, missing or
  mis-owned credential files, a self-update and shutdown refuse the page before
  any container runs.
- The page only pre-fills the existing restore form with `?snapshot=<id>` after
  the exact 64-hex check; any other value is ignored. The restore still re-reads
  the manifest and the exact snapshot under the operation admission.

## Repository check (ADR 0054)

- `POST /stacks/<stack>/backup/check` requires the session, the CSRF token and an
  allowed Origin, and is unavailable when managed sites are disabled. It starts
  one `repository-check` operation under the same per-stack lock as a backup, so
  no panel operation adds packs or snapshots while the check runs. The lock does
  not see an external Restic run; one repository operation at a time stays the
  operator procedure.
- The operation re-reads the manifest and refuses before running a container
  when the site is not managed, declares no backup block, has missing or
  mis-owned credential files, has a pending deploy marker or an unconfirmed
  backup attempt, when the panel updates itself, or when it is shutting down.
- The command is fixed: `restic check --no-lock --read-data-subset 32M` with the
  pinned image, a read-only root filesystem, a bounded tmpfs and the
  operator-owned password file. `--no-lock` keeps an append-only repository free
  of lock objects the panel could not remove; the subset bounds the data read.
  No snapshot id, `--read-data`, `forget`, `prune`, `unlock` or repair command is
  ever passed, and no result, file, fact or cache is written.
- A clean result needs exit code 0 and Restic's own `no errors were found` line.
  Exit codes 1, 10, 11 and 12 map to fixed messages for repository errors, a
  missing repository, a held lock and a wrong password. Exit code 1 carrying
  Restic's zero-size repository message becomes a fixed "nothing to check"
  message instead of a damage claim, because a wiped repository looks identical.
  Neither stdout nor stderr is rendered: they name pack files and print repair
  commands the panel must not run.
- The operation reports exactly the structure plus a random 32 MiB data sample.
  It never claims a full data verification or a restore proof.

## Application toolbox (ADR 0026)

- The panel may execute only **explicitly declared, non-interactive application
  actions** inside a running stack service. There is still no arbitrary command
  execution and no interactive terminal, and the generic "run command" endpoint
  stays prohibited (see Operations above). The new capability is a closed,
  declared set of actions.
- Actions come only from a project's manifest (`extra["compose-panel"]` in
  `composer.json`, `"compose-panel"` in `package.json`), intersected with its
  `scripts`; under the `exec` runner each action carries its own fixed `command`
  instead, a bounded argv whose executable never looks like an option, run as is
  ([ADR 0036](adr/0036-exec-runner.md)). The Compose `x-compose-panel.toolbox.sources` extension only names
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
  never blocks the stack's administration. A generated managed site declares the
  same block as `databaseExplorer` in its version 4 manifest; it is validated by
  the same parser, read only for the card, and never written into the generated
  Compose file ([ADR 0059](adr/0059-managed-site-database-explorer-link.md)).
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

- The one-time host installer ([ADR 0031](adr/0031-ubuntu-installer.md),
  [ADR 0033](adr/0033-debian-host-installation.md))
  provisions packages and an initial Caddyfile after a plan confirmation.
  Private SSH access is the default; optional HTTPS adds a separate Basic Auth
  password. It refuses foreign configuration, symlinked destinations and a
  checkout other local users could modify, stores only quoted password hashes
  in a root-owned 0600 env file (the Caddyfile repeating the Basic Auth hash is
  `root:caddy` 0640) and sends plaintext only through hasher stdin. The first
  image is trusted from the GHCR `latest` tag over TLS, without a digest check
  against `releases.json`. It never changes SSH/firewall rules or
  replaces an existing Docker installation. Package failure is not rolled back
  automatically; see [installation and recovery](installation.md).

- Installation (`scripts/setup-caddy.sh`) is a separate, root-run
  administrator step with an explicit confirmation: it is the only thing that
  appends the `import` line to the main `Caddyfile` (backup, validation,
  restore on failure). The helper binary is compiled offline from the panel
  image already trusted on the host; nothing is downloaded.

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
  reloading. A missing import refuses before anything is written. A domain
  already routed anywhere in the current adapted configuration (exactly or
  by a `*.` wildcard) is refused before publishing, so a panel site can never
  shadow a route owned by the main `Caddyfile` or another tool; an
  unreadable current configuration refuses too (uniqueness unproven).
- Publication never overwrites: the candidate is written to a random
  exclusive temp file and linked into place, which fails if a file appeared
  meanwhile; a detach restore uses the same no-clobber link.
- Ownership is enforced by a strict file header. Foreign files and externally
  modified managed files are refused, never overwritten or adopted. Repeating
  an identical attach is a no-op without reload; changing a mapping requires
  detach first.
- Concurrency: every attach/detach holds the panel's per-stack lock (so a
  self-update start refuses while one runs, and shutdown drains it) and the
  helper serializes the whole prevalidate → reload sequence behind an
  exclusive lock directory, reclaimed only from a dead holder. Other tools
  that reload Caddy take the same lock with `deploy/caddy/with-caddy-lock.sh`;
  a tool that does not is not coordinated, and this is documented.
- The helper socket's directory (`/run/compose-panel`, root-only `0750`) is
  mounted read-only into the panel, so a socket recreated by systemd stays
  reachable and no other host user can connect.
- Rollback is honest: a failed reload restores the previous file and reloads
  that; a second failure is reported as unknown requiring host intervention.
  Validation/adapt failures remove the unpublished candidate without any
  reload, since the running configuration was never touched.
- The panel verifies before calling: session, allowed Origin and CSRF on both
  endpoints, deployed project identity resolved fail-closed, service
  membership against `config --services`, and the port against the
  TCP `127.0.0.1` published ports of the service's running containers —
  exactly the destination the managed file dials — read through the existing
  read-only inspector. The helper re-validates every field under its lock.
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
- The detail whitelist includes only network names, IPv4 and DNS names from
  `NetworkSettings.Networks` (`DNSNames`, or `Aliases` when unavailable), all
  escaped in HTML. Network IDs, endpoint IDs, MACs, gateways and other endpoint
  fields remain excluded. No network operation is exposed
  ([ADR 0037](adr/0037-container-networks.md)).
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

## Docker storage maintenance (ADR 0040)
- Available to the authenticated administrator like any other mutation; no
  feature flag. The card and the route are always present, but nothing runs
  without a confirmed POST. No Docker call is made on page load beyond what the
  Server page already reads.
- The browser only names one of three fixed scopes. The argument array is built
  on the server, with a hard-coded one-week age floor, the fixed `docker`
  executable and no shell. No filter, amount, label or image reference from a
  request reaches the command line.
- The build-cache scope runs with `BUILDX_BUILDER=default`, so a host that has
  Buildx installed cannot be redirected to a remote BuildKit builder through
  the inherited environment or the current builder selection. The default
  builder is the local docker driver; the legacy CLI ignores the variable.
- Volumes, containers and networks are never removed, and `docker system prune`
  is not offered. The panel acts only on the daemon its socket is connected to.
- The POST requires an active session, an allowed Origin, a matching CSRF
  token, the confirmation field, no pending self-update and no active stack
  mutation. The engine is reserved synchronously before the redirect, so a
  double submit cannot start two runs.
- `StackLocks` makes maintenance mutually exclusive with every stack mutation
  (operations, saves, app actions, rollouts, backup purge) and `hasActive()`
  includes it, so a panel self-update is refused while a prune runs.
- The run is server-side and bounded (timeout, output cap). A timeout or an
  unconfirmed exit is `unknown`; only the unconfirmed case keeps the engine
  lock. The command is irreversible and is never replayed after a crash.
- The audit line records the scope, status, exit code, flags and best-effort
  parsed bytes, never the command output. Reclaimed size stays best effort: an
  unparsed or truncated summary is unknown, never zero.
- The interface states that `unused-images` removes tagged images no container
  references, so future deployments, recreations and rollbacks — including the
  panel's own rollback image, whose age is its creation time — may need a
  download or a rebuild. A stopped container keeps its image.
- Nothing is scheduled. Recurring cleanup remains a host timer, outside the
  panel and outside its guarantees.

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
Tests for `../` paths, encoded URLs, trailing-newline/NUL/double-encoded names, missing STACKS_DIR (fail-closed 503, no Docker call), non-conforming names, symlinks, double Compose, `.env` symlink (editor, mutation and follow), write conflicts, login burst, delay growth and the no-lockout guarantee, session-revocation stream close, unexpected Host rejection, `.env` redaction with comments/quotes and boundary truncation, secrets in errors, CSRF, XSS, concurrent operations, malformed Docker CLI output, timeout/output-cap handling, read-only insights (`docker info` whitelist projection with no registry/proxy/env leak, and unavailable-vs-zero handling), the remote image check (reason classification, capability-based local digest, publish guard on generation/references/local digests, single-flight, Origin/CSRF, no call for `build:` or digest-pinned references), SSE auth/subscriber limits/slow readers, log follow kill-on-last-reader/timeout, audit rotation/retention/read-cap/symlink refusal and no-secret logging, self-update (release policy: 72-hour age from both `published_at` and digest registration, registry mismatch/replacement/idempotent retry refusal rules, streamed response byte caps, draft/prerelease/tag refusal, index digest required in `RepoDigests` under the official repository, GitHub unreachable or unexpected answers refused, fixed release URL without redirects, re-check on install, no GitHub call on render; own-identity validation refusing `..`, relative or CSV-breaking paths, files outside the deployment, digest-pinned or locally built images and a missing socket mount; fail-closed when Docker cannot describe the panel or its image; fixed updater arguments without shell; strict updater argv parsing; refusal of a stale target, a missing release digest, an untaggable rollback image, a changed Compose image or an unrecorded `.env` with nothing recreated; CSRF/Origin/session on both endpoints; refusal during running actions and pause of mutations while updating; never touching a same-named foreign container; escaped updater output; recovery commands quoted), Linux shutdown/restart and stuck processes, dependency audit (`bun audit` on every CI build plus the Trivy image scan).

## CI
Subprocess tests only in a disposable/isolated Docker daemon. Never mount the CI host's production engine socket in automated tests.
