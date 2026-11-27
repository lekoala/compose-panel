# Configuration

Compose Panel reads environment variables from its process. Two examples exist:

- [`deploy/compose-panel.env.example`](../deploy/compose-panel.env.example) is
  the **minimal operator file** for the Compose deployment.
- [`.env.example`](../.env.example) is the **minimal file** for a manual or
  local Bun run.

Neither example is exhaustive on purpose. This page is the full reference:
operator settings, integration settings, advanced tuning, and the variables
that exist only for development or tests. Defaults live in
[`src/config.ts`](../src/config.ts); the panel validates every value at startup
and refuses a malformed, unsafe or unsupported value instead of reinterpreting
it.

Do not copy the advanced table into an operator `.env`. Most deployments never
need it.

## Operator settings

### Required

| Variable | Default | Purpose |
| --- | --- | --- |
| `STACKS_DIR` | none, required | Absolute path to the existing stacks directory. It must be the same path inside and outside the panel container. |
| `COMPOSE_PANEL_ADMIN_USER` | `admin` | Single administrator account. Common names (`admin`, `root`, `user`, `test`, `guest`, …) are refused unless `COMPOSE_PANEL_DEV=true`. |
| `COMPOSE_PANEL_ADMIN_PASSWORD_HASH` | none, required | Argon2id hash, never the password. Generate it with `bun run hash-password` or the image. Single-quote it in a Compose `env_file`: Compose expands `$` in unquoted values. |
| `PORT` | `5081` | HTTP listener. The bind address stays hard-coded to `127.0.0.1`; this only changes the port. |

### Access

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPOSE_PANEL_PROXY_ORIGINS` | empty | Comma-separated exact origins of TLS reverse proxies on this host, for example `https://panel.example.com`. Each request is resolved to one access point; Origin/Host checks, Secure cookies and forwarded-address trust follow it. Entries must be `https` outside development mode, with no credentials, path, query or fragment, no empty entry and no duplicate. |
| `COMPOSE_PANEL_ALLOW_LOOPBACK` | `false` | Also accept the loopback/SSH-tunnel path when proxy origins are configured. Leave it off to expose one path at a time; with no proxy origin, loopback is the only path. |
| `COMPOSE_PANEL_COOKIE_SECURE` | unset | Force `Secure` cookies on the loopback path. The proxy path always follows the matched origin (https means Secure). Use this when the SSH tunnel is itself wrapped in TLS. |

### Optional features

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPOSE_PANEL_MANAGED_SITES_ENABLED` | `false` | Managed websites: `/new-site`, the site card, deploy, backup and restore. The flag is the first gate; a valid manifest is the second. The pilot was validated on a real host on 2026-11-27 ([record](validation/managed-site-pilot-2026-11-27.md)). This is a **temporary maturity gate read at startup**, not a user preference: the supported deployment does not mount or write its own env file. Add the line to the panel's env file (`deploy/compose-panel.env` for the installer or Compose deployment) and recreate the panel ([enable it](deployment.md#optional-managed-site-deploy-adr-0042-adr-0043-adr-0047)). Once the pilot is declared stable, the intended direction is default-on and then removal of the flag; no settings store or in-panel toggle is planned. |
| `COMPOSE_PANEL_DATABASE_EXPLORER_URL` | empty | Optional external explorer (LibreDB Studio, Adminer, pgAdmin…) used by the `x-compose-panel.database` link. The panel only builds the link; it never contacts the explorer or reads a credential. Must be `https` outside development mode, with no credentials, path, query or fragment. See [libredb.md](integrations/libredb.md). |
| `COMPOSE_PANEL_TIMEZONE` | empty | IANA display zone for rendered times, for example `Europe/Brussels`. Empty uses each reader's browser zone. Stored timestamps stay UTC. |
| `COMPOSE_PANEL_AUDIT_ENABLED` | `true` | Append-only NDJSON activity log. On by default; the panel does not need this variable unless the log must be disabled. |

## Integration settings

These are usually written by the installer or a host setup step, not by hand.

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPOSE_PANEL_CADDY_ENABLED` | `false` | Show the Domains section on a stack and allow real attach/detach through the host helper. `scripts/setup-caddy.sh --install` sets this with the socket path below. |
| `COMPOSE_PANEL_CADDY_SOCKET_PATH` | empty | Absolute Unix socket of the privileged Caddy helper, mounted into the panel. A socket path without `COMPOSE_PANEL_CADDY_ENABLED=true` is refused at startup. With the flag and no socket, Domains stays a read-only preview. See [deployment.md](deployment.md#optional-caddy-site-management) and [ADR 0030](adr/0030-optional-caddy-sites.md). |
| `COMPOSE_PANEL_STACKS_PATH_ALIASES` | empty | Comma-separated `hostPrefix=panelPrefix` remaps used after a migration where the Docker-side Compose path differs from the panel's mount. Both sides must be absolute and free of `..`. |
| `COMPOSE_PANEL_AUDIT_DIR` | `<STACKS_DIR>/.compose-panel/audit` | Absolute audit directory. Change only when the default location is not writable or must live on another mount. |

## Advanced tuning

Set these only with a measured reason. They change timeouts, caps or resource
budgets; they are not feature switches, and no operator file needs them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPOSE_PANEL_SESSION_TTL_MS` | 12 h | Absolute session lifetime. |
| `COMPOSE_PANEL_SESSION_IDLE_MS` | 1 h | Idle session lifetime. |
| `COMPOSE_PANEL_LOGIN_WINDOW_MS` | 15 min | Login attempt window. |
| `COMPOSE_PANEL_LOGIN_MAX_ATTEMPTS` | `5` | Attempts per window before the delay starts. There is no hard lockout. |
| `COMPOSE_PANEL_LOGIN_BACKOFF_MAX_MS` | `2000` | Cap of the doubling delay after the limit. |
| `COMPOSE_PANEL_AUDIT_ROTATION` | `day` | `day` or `month`; period files are pruned to the retained count. |
| `COMPOSE_PANEL_AUDIT_RETAIN_FILES` | `31` | Period files kept. |
| `COMPOSE_PANEL_AUDIT_MAX_FILE_BYTES` | 10 MiB | Size cap of one audit file. |
| `COMPOSE_PANEL_AUDIT_MAX_READ_LINES` | `2000` | Lines rendered for one period. |
| `COMPOSE_PANEL_MAX_BODY_BYTES` | 8 KiB | Maximum accepted request body. |
| `COMPOSE_PANEL_MAX_EDIT_BYTES` | 1 MiB | Maximum Compose or `.env` draft. |
| `COMPOSE_PANEL_BACKUP_RETAIN` | `10` | Previous `compose.yaml`/`.env` copies kept per stack. |
| `COMPOSE_PANEL_DOCKER_TIMEOUT_MS` | 5 s | General Docker command deadline. |
| `COMPOSE_PANEL_DOCKER_MAX_BYTES` | 1 MiB | Captured Docker output cap. |
| `COMPOSE_PANEL_INSIGHTS_TIMEOUT_MS` | 10 s | Server-page `docker info`, `stats` and `system df` deadline. |
| `COMPOSE_PANEL_DISK_USAGE_TTL_MS` | 5 min | In-memory cache for the on-demand disk-usage read. |
| `COMPOSE_PANEL_OPERATION_TIMEOUT_MS` | 5 min | Maximum duration of one mutating Compose operation. |
| `COMPOSE_PANEL_SHUTDOWN_GRACE_MS` | 30 s | Drain window for running operations on shutdown. Keep `stop_grace_period` above it. |
| `COMPOSE_PANEL_ROLLOUT_ENABLED` | `false` | Opt-in per-service rollout. The per-service `panel.rollout.*` labels are the second gate ([ADR 0035](adr/0035-optional-service-rollout.md)). |
| `COMPOSE_PANEL_ROLLOUT_TIMEOUT_MS` | 15 min | Overall rollout budget: pull, health wait, drain, stop and cleanup. |
| `COMPOSE_PANEL_MAINTENANCE_TIMEOUT_MS` | 5 min | Maximum duration of one fixed Docker prune. There is no enable flag. |
| `COMPOSE_PANEL_SSE_HEARTBEAT_MS` | 15 s | Live-stream heartbeat. |
| `COMPOSE_PANEL_SSE_TIMEOUT_MS` | 30 min | Maximum lifetime of one SSE subscription. |
| `COMPOSE_PANEL_SSE_MAX_SUBSCRIBERS` | `100` | Process-wide concurrent SSE cap. |
| `COMPOSE_PANEL_LOG_TAIL_LINES` | `200` | History tailed when a log follow starts. |
| `COMPOSE_PANEL_LOG_MAX_BYTES` | 256 KiB | Retained log buffer per stack. |
| `COMPOSE_PANEL_LOG_TIMEOUT_MS` | 30 min | Maximum follow lifetime. |
| `COMPOSE_PANEL_TOOLBOX_MAX_MANIFEST_BYTES` | 256 KiB | Maximum application-action manifest. |
| `COMPOSE_PANEL_TOOLBOX_MAX_ACTIONS` | `50` | Actions accepted from one manifest. |
| `COMPOSE_PANEL_TOOLBOX_MAX_TIMEOUT_MS` | 15 min | Maximum declared action timeout. |

## Security relaxations

These weaken a protection. Never set them on a shared or exposed host.

| Variable | Default | Effect |
| --- | --- | --- |
| `COMPOSE_PANEL_DEV` | `false` | Allows local conveniences such as the `admin` username and `http` proxy origins. |
| `COMPOSE_PANEL_ALLOW_OPAQUE_ORIGIN` | `false` | Accepts an absent or opaque (`null`) Origin when Fetch Metadata says same-origin/none. It lets an embedded or sandboxed context drive the panel; leave it off. |

## Internal and test seams

These are not operator settings. They remain readable so the tests and the
development previews can use a fixed local setup.

| Variable | Default | Why it is internal |
| --- | --- | --- |
| `COMPOSE_PANEL_COMPOSE_ENGINE` | `docker` | V1 supports Docker Compose only. `podman` and every other value are refused at startup; the variable exists to make that refusal explicit ([ADR 0005](adr/0005-compose-provider-boundary.md)). |
| `COMPOSE_PANEL_DOCKER_PATH` | `docker` | The fixed Docker executable. The panel still never uses a shell or user-supplied arguments, but a normal deployment must keep the default; tests and proxy fixtures point it at a wrapper. |
