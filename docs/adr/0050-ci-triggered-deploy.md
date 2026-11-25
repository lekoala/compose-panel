# ADR 0050 — CI-triggered deploy with a site-scoped machine credential

Status: Accepted (managed-site pilot, 2026-11-25). Implemented in the same
change; the real-host checklist remains.

## Context

- ADR 0043 ships a manual deploy behind an administrator session. A CI job that
  has just built and tested a commit cannot use that path: a browser session is
  an ambient credential, and sharing the administrator password with CI would
  make every pipeline a full panel administrator.
- The plan's next increment is one authenticated post-test request against the
  same manual deployment service. It must not become a generic webhook, a
  second deploy implementation or an unauthenticated mutation. ADR 0035's
  rollout and ADR 0024's creation form stay browser-only.
- The panel is loopback-bound and single-operator. A CI job either runs on the
  same host or reaches the panel through the already-reviewed TLS proxy. No new
  public listener is introduced by this ADR.
- Security invariant 2 requires authorization **and** CSRF for a privileged
  mutation. CSRF protects an ambient credential. A bearer token sent in an
  explicit `Authorization` header is not ambient and cannot be attached by a
  cross-site form, so this ADR substitutes a signed-scope machine credential
  and a strict request shape rather than a browser CSRF token. That substitution
  is the reason it needs its own ADR.
- The panel must not store a usable deployment secret: a stolen panel file must
  not let an attacker deploy. The fixed file therefore holds only a SHA-256
  verifier, exactly like the administrator password hash.

## Decision

### Manifest: one optional `ci` block in version 3

```json
"ci": { "kind": "token" }
```

- `ci` is optional, `managed` only, and accepted only in manifest `version: 3`.
  It has exactly one field, `kind`, an allow-list with one value now, `token`.
  Unknown fields still refuse.
- The block changes no generated file: the generator version stays `1` or `2`
  and Compose output is byte-identical. A v3 manifest is a v2 manifest plus the
  optional `backup` block (ADR 0049) and this optional `ci` block.
- Presence of the block is the allow-list entry for the machine route. Removing
  it disables the route on the next request; it is the primary revocation.
- The deploy ref is not configurable here: the request must name
  `deploy.git.ref` exactly, so a CI credential can never deploy another branch.

### Fixed private verifier

- `<stack>/site/private/ci/` is mode `0700`, owned by the panel account, outside
  releases, `generated/`, `public/` and every service mount.
- `deploy-token.sha256` is a regular file, one link, mode `0600`, at most
  256 bytes, owned by the panel account. It holds one lowercase 64-hex SHA-256
  digest, optionally followed by one newline, and nothing else.
- The operator generates a high-entropy token (for example
  `openssl rand -hex 32`) and stores only its digest. The raw token lives in the
  CI secret store; the panel never receives it in a file, never logs it and
  never renders it.
- The metadata is checked before the digest is read, and the digest is read
  with no-follow semantics. The panel compares `sha256(presented)` with the
  stored digest in constant time. A missing, loose, linked or malformed verifier
  makes every machine request unauthenticated; the site page shows why, and the
  audit record names the reason without a secret.
- Rotation is replacing the file with a new digest. Revocation is deleting the
  file or removing the `ci` block. No panel restart is required.

### Endpoint and request shape

- `POST /api/managed-sites/<stack>/deploy`, only when managed sites and the
  `ci` block are enabled.
- `Authorization: Bearer <token>`, token bounded to 32-128 characters of
  `[A-Za-z0-9_-]`. Any other scheme, a missing header or a wrong digest answers
  `401` with `{"error":"Unauthorized"}` and does not parse the body.
- `Content-Type: application/json` (an optional charset is accepted). A
  cross-site HTML form cannot send that content type, and the panel enables no
  CORS, so a browser cannot turn an administrator session into a machine
  request.
- Body at most 8 KiB, one JSON object with exactly four fields:

  ```json
  { "sha": "<40 lowercase hex>", "ref": "refs/heads/main",
    "nonce": "<16-64 of [A-Za-z0-9_-]>", "timestamp": "2026-11-25T10:00:00.000Z" }
  ```

  Unknown, missing or extra fields, a short or decorated SHA, another ref, a
  malformed timestamp or a malformed nonce is `400` and runs nothing.
- `timestamp` must be within 300 seconds of panel time in either direction.
  This bounds a captured request without requiring a clock-perfect CI host.
- The nonce is consumed once per site. Accepted nonces are kept in a durable
  bounded record, pruned to the replay window and capped at 32 entries. A
  repeated nonce, even inside the window, is refused before the operation
  starts, and the locked re-check refuses it again if two requests race.
- Ten failed authentications for one site within 60 seconds answer `429` until
  the window passes. A success clears the counter. The counter is in memory: a
  restart only forgets recent failures, it never weakens a token.
- Every response sets `Cache-Control: no-store`. The body never contains the
  token, a credential path or operation output.
- The panel stays loopback-bound. A CI on the host calls the loopback address; a
  remote CI goes through the documented TLS proxy, like the administrator. The
  token belongs in the CI secret store and never in a URL, a query string or a
  log line.

### Admission, deploy and idempotency

- The route authenticates and validates the request shape, then starts the
  existing deploy operation under the per-stack lock. It does not implement a
  second deploy.
- The locked closure re-reads the manifest, re-checks the verifier digest and
  the nonce, refuses a pending deploy attempt, a pending backup attempt or a
  running operation, and only then records the attempt.
- After the Git fetch, and before any container is stopped, the fetched ref tip
  must equal the requested `sha`. If the branch moved, the deploy is refused
  with both SHAs named and nothing is stopped. This is the "tested SHA equals
  the allowed branch tip" rule.
- A request for the SHA that already serves is the existing verified no-op. It
  consumes the nonce and is reported as `noop`; it is never treated as a second
  deploy.
- A crash or timeout keeps the existing attempt marker and the deploy's own
  unknown-outcome rule. A retry with a fresh nonce stays refused until the
  operator acknowledges the marker; no automatic second deploy exists.
- `202` means the operation was accepted, not that it finished. It returns
  `{ "siteId", "sha", "operationId" }`. `409` covers a busy stack, a pending
  marker, a replayed nonce or `latest`-style ambiguity. `503` covers a panel
  shutting down or updating itself.

### Durable fact and status

- `site/private/ci/last-attempt.json` (bounded, `0600`, atomic replace) records
  the site id, ref, requested SHA, acceptance time, coarse result
  (`accepted`, `succeeded`, `refused`, `failed`) and the accepted nonces.
  It is an operator fact for the next request and the site page, never a
  recovery journal: it is not replayed and not used as a deploy input.
- `GET /api/managed-sites/<stack>/deploy` with the same bearer token returns
  `{ siteId, ref, currentRelease, lastAttempt }`. It exposes no output, no path,
  no credential and no other stack. `currentRelease` is the verified baseline
  release id, or `null` when there is none.
- The site page shows the CI block, the verifier check, the endpoint path and
  the last attempt, so an operator can revoke or diagnose without reading the
  files by hand.

### Audit and limits

- Every request records `deploy` with action `ci-deploy`, the network client
  key, the stack, the requested SHA and the coarse result. It never records the
  token, the Authorization header, the body or operation output.
- There is no scheduler, webhook registry, branch creation, image build,
  migration, arbitrary command or second credential kind. One token per site,
  one deploy action, one ref.
- The machine path goes through the same admission as the browser deploy: it
  refuses a pending marker, generated-file drift and a missing prerequisite. It
  adds one machine-specific gate (the verifier and the nonce) and removes none.

## Consequences

- A pipeline can promote the exact commit it tested without holding the
  administrator password, and a leaked panel file yields only a verifier.
- The operator gains one digest file per participating site and one CI secret.
  Revocation is immediate and local.
- The panel gains a bounded request parser, a metadata-only verifier check, a
  durable nonce/attempt record, one route and one admin card section. It gains
  no new dependency, listener, scheduler, token store or deploy path.
- A stale delivery is refused rather than deploying an older commit: CI must be
  triggered from the branch tip. A force-push that rewrites the branch is
  therefore refused until CI runs again on the new tip.
- CSRF is not used on this route because no ambient credential is accepted.
  This is a deliberate, documented exception to the browser rule, not a general
  relaxation: every browser mutation keeps Origin, CSRF and session checks.

## Alternatives considered

- **Reuse the administrator session with a cookie from CI.** Stores the
  administrator password outside the panel, gives CI every panel action and
  makes CSRF meaningless; rejected.
- **A shared secret in the URL (`?token=`).** Leaks through proxies, logs and
  browser history; rejected.
- **Store the raw token in a private file.** A stolen panel file would then be
  directly usable to deploy; a digest verifier is strictly better.
- **HMAC over the body.** Stronger binding, but it requires storing the raw
  signing key, which is the same secret-store problem. TLS plus a bearer token,
  a strict body, a timestamp window and a consumed nonce cover the same replay
  and tampering risks without a usable key at rest. An HMAC variant can be a
  later ADR if a CI must run without TLS.
- **Trust the CI's claimed SHA without comparing the ref tip.** Lets a stale or
  crafted request deploy an older, untested commit; rejected.
- **A generic webhook with event parsing.** Adds provider-specific payloads,
  signatures and failure modes the pilot does not need; rejected.
- **A scheduler inside the panel.** Out of scope; CI already owns scheduling.

## Verification

- Unit tests: the `ci` manifest block (version, owner, kind allow-list, unknown
  fields), verifier metadata and digest checks, token bounds and constant-time
  comparison, strict body parsing (SHA, ref, nonce, timestamp, unknown fields),
  the 300-second window, durable nonce acceptance, replay and pruning, the
  expected-SHA refusal after a moved branch, and the state file bounds.
- App tests: a session cookie alone is refused; a wrong token is `401`; a
  malformed body is `400`; the correct token starts one deploy operation under
  the lock; a second concurrent request is `409`; a replayed nonce is `409`; a
  moved branch is refused with nothing stopped; `GET` returns the bounded status
  and no secret; the audit line never contains the token.
- The disposable lab already proves the deploy path this route reuses. No new
  Docker fixture is needed for request parsing, but the real-host checklist
  still covers the TLS proxy path and the CI host clock.
- Real host: part of
  [deployment.md](../deployment.md#remaining-real-host-validation). Record one
  deploy triggered by the chosen CI through the reviewed proxy, one revocation,
  and one stale-SHA refusal.

## Out of scope

Scheduling, webhook registries, provider-specific signatures, OIDC or cloud
identity, per-branch tokens, branch creation, image builds, migrations,
arbitrary commands, multi-user access, a public API, and any deploy path that
does not reuse the manual deploy operation. An HMAC or mTLS variant needs its
own ADR.
