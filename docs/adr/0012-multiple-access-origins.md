# ADR 0012 — Multiple access origins and the loopback path

Status: accepted.

## Context
[ADR 0010](0010-reverse-proxy-mode.md) modelled proxy access as one setting,
`COMPOSE_PANEL_PUBLIC_ORIGIN=https://<host>`, and refused a form posted through
the SSH tunnel while it was set: the Origin of that path is the loopback one.
An operator who wants HTTPS *and* the tunnel had to pick one at a time, and a
second hostname (a private `*.ts.net` name next to a public domain) was not
possible at all. The panel must still know nothing about Tailscale, Caddy or
SSH: it only knows which origins are allowed to reach it.

## Decision
- **Replace the single origin with a list.**
  `COMPOSE_PANEL_PROXY_ORIGINS=https://a,https://b` holds every explicitly
  allowed reverse-proxy origin. Entries are normalized to
  `scheme://host[:port]`; credentials (`user:pass@`), a path, query or fragment,
  empty entries and duplicates are refused at startup, and `http:` is refused
  outside `COMPOSE_PANEL_DEV=true`.
- **Add the loopback path explicitly.** With no proxy origin configured, the
  loopback/SSH-tunnel path is implicit. With one or more proxy origins, loopback
  is refused unless `COMPOSE_PANEL_ALLOW_LOOPBACK=true`, so reaching the panel
  two ways at once is an opt-in.
- **Resolve an access point per request from the Host header.** A request is a
  *loopback* access (loopback authority on `PORT`, when enabled) or a *proxy*
  access (Host exactly equals a configured origin's host), or it is refused
  before routing. Origin/Referer, the cookie `Secure` attribute and
  X-Forwarded-* trust all follow the resolved access point:
  - Origin/Referer must equal the resolved proxy origin, or the loopback origin
    the client used; a request that mixes the two paths is refused;
  - cookies are `Secure` on an https proxy origin and follow
    `COMPOSE_PANEL_COOKIE_SECURE` (default false) on loopback, so an SSH tunnel
    over plain HTTP still signs in;
  - `X-Forwarded-Proto`/`-For` are read only on a proxy access; on loopback they
    are ignored and the client key is `direct`.
- **The bind stays hard-coded to `127.0.0.1`.** No configuration can publish the
  panel.
- **Legacy settings fail fast, they are not reinterpreted.**
  `COMPOSE_PANEL_PUBLIC_ORIGIN` and `COMPOSE_PANEL_TRUST_PROXY` are refused at
  startup with an actionable message; reinterpreting security configuration
  silently would change the access policy without the operator asking.

## Trust boundary (explicit)
The Host header selects the *configured access point*; it does **not**
authenticate the reverse proxy. The proxy and an SSH tunnel both reach the
loopback listener, and a client able to reach it can present a proxy-origin Host
plus a forged `X-Forwarded-For`. This cannot bypass authentication or CSRF (the
session cookie and token are still required and the Origin check still runs),
but it can misattribute the sign-in throttle key and the audit `actor`. For the
V1 threat model — one trusted administrator, a local proxy, an SSH tunnel —
that is accepted and documented rather than solved; isolating proxy trust would
need separate listening sockets or an authenticated proxy, which is out of scope.
`app.test.ts` pins this known limitation.

Only the **last** `X-Forwarded-For` entry is read: the one the local proxy
appended. Vendor identity headers such as Cloudflare's `CF-Connecting-IP` are
ignored, and the panel never authorizes a request because it carries an
identity-proxy header — authentication stays its own. With several intermediaries
(for example Cloudflare edge → Caddy → panel) the last entry is the last proxy,
not necessarily the visitor; deploying the panel with one trusted proxy keeps
the client address meaningful (see the Cloudflare case in `docs/deployment.md`).

## Consequences
- HTTPS and the SSH tunnel can be used at the same time; two HTTPS origins (for
  example a public domain and a private overlay name) can both be allowed, with
  no provider-specific code.
- The proxy path no longer competes with the tunnel for one access mode: there
  are no `ssh`, `caddy` or `tailscale` modes in the code, only allowed origins.
- This is a breaking configuration change before 1.0: startup refuses the old
  variables. The migration is one rename (see `docs/deployment.md`).
- ADR 0010's single-origin rule and its refusal of `COMPOSE_PANEL_COOKIE_SECURE`
  / `COMPOSE_PANEL_TRUST_PROXY` are superseded; its hard-coded loopback bind
  stays in force.
