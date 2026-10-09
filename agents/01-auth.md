# Agent 01 — Auth / security gate

**Mission**: add single-admin authentication, sessions and CSRF BEFORE any non-loopback access or mutating endpoint. Study the behavior of a reverse proxy, SameSite/Secure and SSE requests. Do not depend on an SSO provider or add an ORM.

**Deliverables**: accounts initialized from a secure secret outside the repo, session rotation on login, HttpOnly and Secure cookies behind TLS, logout, CSRF on POST, login attempt limit, protected Compose pages and tests. Explicit proxy contract; by default still 127.0.0.1 until full verification.

**Rejected**: disabling auth, retrieving credentials from the query string, storing passwords in clear text, public auto-login, frontend JWT in localStorage.

**Acceptance**: all sensitive routes are inaccessible without a session, POST without CSRF rejected, no caching of `.env`, unauthorized read attempt rejected. Update `docs/security.md` and validate on Linux.
