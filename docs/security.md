# Security — mandatory boundaries

## Main risk
An administrator able to edit and then deploy a Compose file on a rootful Docker daemon can obtain very high control over the host. This panel is **not** a Docker sandbox, nor a multi-tenant API. Trusted users only.

## Delivered prototype
- Local loopback `127.0.0.1` only, no exposed bind and **no authentication**: local read-only prototype.
- The YAML may contain secrets despite the lack of `.env` access. Do NOT place the prototype behind a public proxy.
- No modification endpoint and no Docker execution. The first agent mission concerns authentication.

## Minimum before remote/production use
- Single-admin auth (secret provisioned outside the repo, robust password derivation, HttpOnly, Secure, SameSite cookies, session rotation after login, logout).
- CSRF on all POSTs and strict Origin/Host checks, behind an explicitly configured proxy.
- TLS via proxy, bind on a private interface, firewall/administration network. Never expose the Docker socket over TCP.
- Limit file sizes, execution time, log/SSE size, login attempts.
- Escape HTML, restrictive CSP, disable caching of sensitive pages, protect any response containing `.env`.
- Ensure safe resolution of names and files: name allow-list, reject symlinks, protect the root path, no absolute paths supplied by the user.
- Subprocesses via argument arrays, no shell. No freely user-supplied options. No generic Docker command.
- Backups before modifications, controlled concurrency, operation limits and graceful shutdown.
- Docker logs may themselves contain secrets. Never include them in unprotected application logs.

## Mandatory security checks
Tests for `../` paths, encoded URLs, non-conforming names, symlinks, double Compose, `.env` symlink, write conflicts, secrets in errors, CSRF, XSS, concurrent operations, Linux shutdown/restart and stuck processes.

## CI
Subprocess tests only in a disposable/isolated Docker daemon. Never mount the CI host's production engine socket in automated tests.
