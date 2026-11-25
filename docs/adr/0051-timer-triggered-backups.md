# ADR 0051 — Timer-triggered backup requests and distinct freshness facts

Status: Accepted (managed-site pilot, 2026-11-25). Implemented in the same
change; the real-host checklist remains.

## Context

- ADR 0049 ships a manual, administrator-triggered offsite backup. It explicitly
  assigns scheduling to an **administrator-installed host timer** that must
  request the same guarded backup "over a local authenticated machine path",
  keeps retention outside the panel, and requires last attempt, last good
  snapshot and last successful test restore to be distinct facts
  ([ADR 0049](0049-offsite-backup-and-restore.md)).
- A browser session is an ambient credential and cannot be held by a timer.
  Sharing the administrator password would give the timer every panel action.
  ADR 0050 introduced one site-scoped machine credential for a deploy; this ADR
  adds a second, separate credential for a backup so that a backup token can
  never deploy and a deploy token can never back up.
- Security invariant 2 requires authorization and CSRF for a privileged
  mutation. As in ADR 0050, no ambient credential is accepted here: the route
  requires an explicit `Authorization: Bearer` header and a JSON content type,
  which a cross-site form cannot set. That documented substitution is the reason
  this needs its own ADR.
- The panel must remain a single Bun process with no scheduler. "Overdue" is a
  displayed fact derived from a durable timestamp, never a panel-owned timer, a
  retry or a notification.
- Retention (prune, forget, deletion credentials) stays outside the panel:
  ADR 0049 already decided it runs as an operator procedure with separate
  administration credentials. This ADR does not move it into the panel.

## Decision

### Manifest: one optional `trigger` inside `backup`

```json
"backup": {
  "kind": "restic",
  "repository": "rest:https://backup.example.test/acme-shop",
  "trigger": { "kind": "token", "everyHours": 24 }
}
```

- `backup.trigger` is optional, `managed` only (the `backup` block already is)
  and lives in manifest `version: 3`. It has exactly two fields: `kind`, an
  allow-list with one value now (`token`), and `everyHours`, an integer from 1
  to 720. Unknown fields, a non-integer or an out-of-range value are refused.
- `everyHours` is the declared **maximum age** of the last verified backup before
  the panel reports it overdue. It is not a schedule: the panel starts nothing,
  and the administrator's timer is the only scheduler. The operator is expected
  to run the timer at least that often.
- The block changes no generated file: generator and Compose output are
  byte-identical. Removing it removes the machine route on the next request and
  stops the facts from being updated; it is the primary revocation.
- A machine backup request always uses this site's declared repository and
  scope. Nothing in the request can name a repository, a scope or a snapshot.

### Fixed private verifier

- `site/private/backup/trigger-token.sha256` is a regular file, one link, mode
  `0600`, at most 256 bytes, inside the existing `site/private/backup/`
  directory that must already be `0700` and owned by the panel account.
- It holds one lowercase 64-hex SHA-256 digest, optionally followed by one
  newline, and nothing else. The operator stores only the digest; the raw token
  lives in the timer's environment or its secret store.
- The metadata is checked before the digest is read, the read is no-follow, and
  the comparison is constant-time, using the shared machine-credential
  primitives introduced with ADR 0050. A missing, loose, linked or malformed
  verifier makes every machine request unauthenticated; the site card shows why
  and the audit line names the reason without a secret.
- Rotation replaces the digest; revocation deletes the file or removes the
  `trigger` block. No restart is required.

### Endpoint and request shape

- `POST /api/managed-sites/<stack>/backup`, only when managed sites are enabled
  and the site declares `backup.trigger`.
- `Authorization: Bearer <token>`, token bounded to 32-128 characters of
  `[A-Za-z0-9_-]`. Any other scheme, a missing header or a wrong digest answers
  `401` with `{"error":"Unauthorized"}` and does not parse the body.
- `Content-Type: application/json` (an optional charset is accepted), otherwise
  `415`. No CORS is enabled.
- Body at most 8 KiB, one JSON object with exactly two fields:

  ```json
  { "nonce": "<16-64 of [A-Za-z0-9_-]>", "timestamp": "2026-11-25T10:00:00.000Z" }
  ```

  Unknown, missing or extra fields and a malformed nonce or timestamp are `400`
  and run nothing. A `sha`, a `ref`, a repository or any other deploy-shaped
  field is therefore refused rather than ignored.
- The timestamp must be within 300 seconds of panel time in either direction.
- Nonces are consumed once per site and kept in the same durable bounded record
  as the other facts, pruned to the replay window and capped at 32 entries. A
  repeated nonce is refused before the operation starts and again under the
  lock.
- Ten failed authentications for one site within 60 seconds answer `429` until
  the window passes; a success clears the counter. The counter is in memory and
  a restart only forgets recent noise.
- Every response sets `Cache-Control: no-store` and never contains the token, a
  credential path or operation output.

### Admission and reuse of the manual backup

- The route authenticates and validates the request shape, then starts the
  **same** backup operation as the browser button, under the per-stack lock. It
  does not implement a second backup, a second staging path or a second Restic
  invocation.
- The locked closure re-reads the manifest, re-checks the verifier digest, the
  nonce, the pending deploy marker, the pending backup marker and the operation
  lock, records the accepted attempt, and only then runs the backup.
- The existing admission is unchanged: no drift gate is added or removed, and a
  pending marker still refuses with nothing run.
- `202` means accepted, not finished. It returns
  `{"siteId","operationId"}`. `409` covers a busy stack, a pending marker or a
  replayed nonce; `503` covers a panel shutting down or updating itself.
- A crash or timeout keeps the existing backup attempt marker and its
  unknown-outcome rule. A retry with a fresh nonce stays refused until the
  operator acknowledges the marker; no automatic second backup exists.

### Durable facts and status

- `site/private/backup/trigger-state.json` (bounded to 16 KiB, `0600`, atomic
  replace inside the checked `0700` directory) records:

  ```json
  {
    "version": 1,
    "siteId": "acme-shop",
    "lastAttempt": { "at": "...", "result": "accepted|succeeded|refused|failed" },
    "lastSuccess": { "at": "...", "snapshotId": "<64 hex>" },
    "lastProof": { "at": "...", "snapshotId": "<64 hex>" },
    "nonces": [{ "nonce": "...", "at": "..." }]
  }
  ```

  `lastSuccess` and `lastProof` are `null` until recorded. The file is a display
  and diagnosis fact, never a recovery journal and never an input to a backup or
  restore.
- Any successful backup of a site that declares `trigger` updates
  `lastSuccess`, whether it was started by the timer or by the administrator.
  A verified restore of an exact snapshot updates `lastProof`. A failure to
  update the facts never turns a successful backup or restore into a failure;
  the operation output says the record is stale.
- `GET /api/managed-sites/<stack>/backup` with the same bearer token returns
  `{ siteId, everyHours, lastAttempt, lastSuccess, lastProof, overdue, dueAt }`.
  It exposes no output, no path, no credential and no other stack.
- `overdue` is `lastSuccess === null || now > lastSuccess.at + everyHours`. It is
  computed from the durable fact, so a panel that was down over the interval
  reports overdue on the next page load instead of losing the fact. A backup in
  progress does not clear overdue until it succeeds.
- The site card shows the declared interval, the verifier check, the endpoint,
  the last attempt, the last good snapshot, the last verified restore and the
  overdue state, so the operator can diagnose without reading the files. It also
  states that the panel runs no timer.

### Audit and limits

- Every request records `backup` with action `scheduled-backup`, the network
  client key, the stack and the coarse result. It never records the token, the
  Authorization header, the body or operation output.
- There is no scheduler, timer installation, retention, prune, snapshot
  deletion, notification, webhook registry, arbitrary command or second
  credential kind. One token per site, one backup action, one repository per
  site, exactly as declared in the manifest.
- The administrator installs and owns the timer. This ADR adds an example
  procedure and a real-host checklist item; it adds no unit or init-system
  integration to the panel.

## Consequences

- A host timer can keep the offsite copy fresh without holding the administrator
  password, and the panel stores only a digest.
- The three facts ADR 0049 requires become distinguishable and durable, and the
  card and API report them honestly across a panel restart.
- The panel gains one optional manifest field, one verifier file, one bounded
  state file, one request parser, one route and one card subsection. It reuses
  the deploy credential primitives, the backup operation and the existing
  admission; it gains no dependency, listener, timer or second backup path.
- The operator gains one digest file, one timer unit and one monitoring
  responsibility. Overdue is the only signal; alerting remains out of scope.
- Retention remains a separate, credentialed, off-panel procedure. Automating
  it would need its own ADR and deletion credentials.

## Alternatives considered

- **Reuse the ADR 0050 deploy token.** One token would then deploy and delete
  the ability to back up independently; a leaked deploy token would also
  authorize data exports. Separate scopes and separate files are strictly
  smaller.
- **A panel-owned scheduler or `setInterval`.** Violates the single-process,
  no-scheduler scope, loses runs across restarts and duplicates the host's
  timer semantics; rejected.
- **Keep overdue in memory.** A restart would forget that the site has not been
  backed up for a week, which is exactly the case the status exists for.
- **Let the request choose a repository, paths or a snapshot.** Turns the route
  into a generic backup API and a data-exfiltration surface; the manifest owns
  the scope and a restore proof stays a separate browser action.
- **Prune inside the panel.** Needs deletion credentials, a dry-run, protection
  of the last verified recovery point and serialized check/prune; ADR 0049
  already places it outside the panel.
- **Notifications.** Need a delivery channel, retries and a durable outbox;
  overdue is the on-disk fact such a feature would build on, so it comes first.

## Verification

- Unit tests: the manifest `backup.trigger` block (presence requires `backup`,
  kind allow-list, integer bounds, unknown fields), the shared digest-file
  check and token comparison, strict body parsing (exactly nonce and timestamp,
  unknown/missing fields, SHA-shaped extras refused), the 300-second window,
  nonce replay and pruning, state parsing and bounds, and the overdue
  computation for fresh, never-backed-up and stale facts.
- App tests: a session cookie alone is refused; a wrong token is `401`; a site
  without `trigger` is `404`; a malformed body is `400`; a wrong content type is
  `415`; the correct token starts one backup operation under the lock; a replay
  is `409`; a successful backup records `lastSuccess` and a failed run keeps the
  previous one; a verified restore records `lastProof`; `GET` returns the
  bounded status and no secret.
- Implemented on 2026-11-25. The full unit/app suite passes on Windows and
  Linux, and the disposable backup suite still passes. No host timer, real
  host, proxy path or revocation has been exercised.
- Real host: part of
  [deployment.md](../deployment.md#remaining-real-host-validation). Install one
  timer, record one run, simulate a missed run, revoke the verifier and confirm
  `401` with the site unchanged.

## Out of scope

Panel-owned scheduling, timer installation, retention/prune, snapshot deletion,
notifications, public APIs, per-run output retrieval, choosing a repository or
scope in the request, live restore, deployment triggers (ADR 0050), and any
backup path that does not reuse the manual backup operation. A read-only
measurement of a declared retention policy is ADR 0052; it deletes nothing.
