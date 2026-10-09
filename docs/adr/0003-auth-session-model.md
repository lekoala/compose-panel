# ADR 0003 — Authentication and session model

Status: accepted.

## Decision
- Single administrator. The password is never stored; the server holds an Argon2id hash supplied through `COMPOSE_PANEL_ADMIN_PASSWORD_HASH`, generated with `bun run hash-password` (Bun.password, no new dependency).
- Sessions are random, opaque, server-side identifiers kept in memory. The cookie carries only the id and is `HttpOnly`, `SameSite=Lax`, `Secure` when configured. The id rotates on every login and expires on an idle timeout or an absolute TTL.
- CSRF uses two mechanisms: a double-submit cookie on the login page (no session yet) and a per-session token embedded in authenticated forms. Both are combined with a strict Origin/Referer check that fails closed.
- Login attempts are rate-limited per client key, with a bounded request body.

## Why
- Opaque server-side ids avoid the stateless-JWT pitfalls (revocation, key management, storage in the frontend) and keep the scope small. A stolen id can be revoked by deleting it.
- Deriving the password from an environment hash avoids a database and keeps the secret outside the repo, consistent with ADR 0002 (no durable store in V1).
- Keeping the bind hard-coded to `127.0.0.1` means the Secure-cookie and proxy concerns are configurable but not relied upon yet.

## Consequences
- Sessions are lost on restart; the administrator logs in again. This is acceptable while the panel is a single loopback process.
- Horizontal scaling or restart persistence would require a shared/session store: open a new ADR before adding one.
- If a durable audit log or multi-user support becomes necessary, revisit this decision rather than extending it silently.
