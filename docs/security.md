# Security — mandatory boundaries

## Main risk
An administrator able to edit and then deploy a Compose file on a rootful Docker daemon can obtain very high control over the host. This panel is **not** a Docker sandbox, nor a multi-tenant API. Trusted users only.

## Delivered prototype (P1)
- Local loopback `127.0.0.1` only, no exposed bind. A single administrator authenticates; the password is stored only as an Argon2id hash (`Bun.password`) supplied outside the repo.
- Sessions are random server-side identifiers kept in memory (lost on restart). Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` when `COMPOSE_PANEL_COOKIE_SECURE=true`; the session id rotates on login.
- All mutating requests (login, logout) require a matching CSRF token and an exact Origin/Referer match. The login page uses a double-submit CSRF cookie; authenticated pages use a per-session token.
- Login attempts are rate-limited per client; request bodies and login payloads are size-bounded; every application response is `Cache-Control: no-store`.
- No Docker call, no modification endpoint. The YAML may still contain secrets: do NOT place the panel behind a public proxy yet.

## Proxy and TLS contract
- Default remains direct loopback HTTP with `COMPOSE_PANEL_COOKIE_SECURE=false`.
- Behind TLS, set `COMPOSE_PANEL_COOKIE_SECURE=true` and, for a proxy, `COMPOSE_PANEL_PUBLIC_ORIGIN=https://<host>` so Origin checks compare against the public origin. Set `COMPOSE_PANEL_TRUST_PROXY=true` only when the proxy overwrites `X-Forwarded-Proto`/`X-Forwarded-For`.
- Bind stays hard-coded to `127.0.0.1` until the reverse proxy, TLS termination and firewall are reviewed and documented.

## Minimum before remote/production use
- Auth mono-admin (secret provisioned outside repo, robust password derivation, cookies HttpOnly, Secure, SameSite, rotation de session après login, logout). *(implemented in P1)*
- CSRF on all POSTs and strict Origin/Host checks, behind an explicitly configured proxy. *(CSRF and same-origin checks implemented in P1; proxy configuration still to be verified on a real deployment)*
- TLS via proxy, bind on a private interface, firewall/administration network. Never expose the Docker socket over TCP.
- Limit file sizes, execution time, log/SSE size, login attempts. *(login attempts and request body size implemented in P1; file/log/SSE limits arrive with the corresponding features)*
- Escape HTML, restrictive CSP, disable caching of sensitive pages, protect any response containing `.env`.
- Ensure safe resolution of names and files: name allow-list, reject symlinks, protect the root path, no absolute paths supplied by the user.
- Subprocesses via argument arrays, no shell. No freely user-supplied options. No generic Docker command.
- Backups before modifications, controlled concurrency, operation limits and graceful shutdown.
- Docker logs may themselves contain secrets. Never include them in unprotected application logs.

## Mandatory security checks
Tests for `../` paths, encoded URLs, non-conforming names, symlinks, double Compose, `.env` symlink, write conflicts, secrets in errors, CSRF, XSS, concurrent operations, Linux shutdown/restart and stuck processes.

## CI
Subprocess tests only in a disposable/isolated Docker daemon. Never mount the CI host's production engine socket in automated tests.
