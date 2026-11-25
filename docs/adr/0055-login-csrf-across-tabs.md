# ADR 0055 - Keep one login CSRF token across sign-in tabs

Status: Accepted (2026-11-25). Implemented in the same change.

## Context

- [ADR 0003](0003-auth-session-model.md) protects the sign-in form with a
  double-submit cookie: `GET /login` puts a random token in the HttpOnly
  `cp_csrf` cookie and in a hidden form field, and the POST runs only when the
  cookie and the form token are identical and the Origin/Referer check passes.
  Authenticated pages use a different, per-session token.
- Every `GET /login` minted a new token and overwrote the cookie, and every
  failed attempt did the same. Two sign-in tabs therefore invalidated each
  other: the older form posted a token that no longer matched the cookie and was
  refused with "The sign-in form expired", although nothing was wrong. A wrong
  password in one tab did the same to the other.
- `docs/troubleshooting.md` already names "two sign-in tabs open at once" as a
  cause, and `docs/roadmap.md` tracks the limitation under *Login CSRF across
  tabs and access modes*. Rotating on every page load was incidental, not a
  documented guarantee.

## Decision

- `GET /login` reuses the token already present in `cp_csrf` when it has exactly
  the shape this panel issues: 32 random bytes encoded as 43 base64url
  characters. It mints a token and sets the cookie only when the cookie is
  missing or malformed.
- The failure page follows the same rule, so a wrong password, a rate-limit
  refusal or a busy panel keeps the token that was already in the cookie. A
  stale POST whose form token does not match the cookie still gets a fresh page
  that matches the cookie.
- The POST check is unchanged: the cookie must be present, the form token must
  equal it in constant time, and the Origin/Referer must match the access path.
- The cookie keeps its attributes: `Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure`
  only on an https origin, no `Max-Age`, so it ends with the browser session.
  Nothing is stored server-side, no new secret is introduced and no token is
  logged.
- Authenticated pages, sessions, logout and the per-session token are unchanged.
  The change is limited to the pre-authentication login form.

## Why reuse does not weaken the check

- The token stays 256-bit random, is delivered only in a same-origin `no-store`
  page and an HttpOnly cookie, and is never placed in a URL, a log or the
  activity feed.
- With double-submit, the cookie is the secret half and the form field proves
  same-origin delivery. A leaked form token is useless without the cookie, which
  this change does not expose; the token now lives as long as its session cookie
  instead of until the next `/login` load.
- The residual double-submit weakness is unchanged: a sibling subdomain able to
  set a parent-domain cookie can already post a matching cookie and form pair
  without ever loading `/login`. Removing that would need a server-signed token
  and is not part of this fix.

## Consequences

- Opening two sign-in tabs, or retrying after a wrong password in another tab,
  no longer breaks the first form. The troubleshooting page no longer lists two
  tabs as a cause and the roadmap item is done.
- A cleared or malformed cookie still produces a fresh token and cookie, so
  recovery from deleted browser data is unchanged.
- One new pure predicate validates the token shape; nothing else in the login
  flow changes.

## Alternatives considered

- **Keep rotation and ask operators to use one tab.** Leaves an ordinary
  workflow broken for no security gain: rotation on each page load was
  incidental, not a documented guarantee; rejected.
- **Keep a server-side set of recently issued tokens with an expiry.** It also
  supports tabs and would defeat cookie injection, but adds mutable state to a
  pre-authentication page, plus an eviction path a `GET /login` flood could
  exercise; rejected in favour of the stateless reuse.
- **Sign the token with a process secret and a timestamp.** Stronger against
  cookie injection and bounded in time, but needs a new secret, a clock rule and
  its own failure modes for a problem that is about tab usability; a separate
  hardening if the threat model changes; rejected here.
- **Bind the token to the client address.** Access modes (loopback, tunnel,
  proxy) and proxy chains make the address unstable, and the client address is
  already an untrusted throttle key; rejected.

## Verification

- Unit tests cover the token-shape predicate: an issued token is accepted, a
  short, long, empty or differently encoded value is not.
- App tests cover two `GET /login` requests sharing one token and one cookie,
  a form from the first tab signing in, a failed password keeping the token and
  the second attempt succeeding, a missing cookie still refusing the POST, a
  malformed cookie being replaced, and a form token that does not match the
  cookie still being refused. The existing Origin/access-path tests are
  unchanged.
- The Windows and Linux suites both cover the change; no Docker, browser
  automation or real host is involved.
