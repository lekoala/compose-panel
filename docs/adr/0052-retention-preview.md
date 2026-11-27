# ADR 0052 — Measure retention with a read-only preview

Status: Accepted (managed-site pilot, 2026-11-25). Implemented in the same
change; the real-host checklist was run and recorded on 2026-11-27
([record](../validation/managed-site-pilot-2026-11-27.md)).

## Context

- [ADR 0049](0049-offsite-backup-and-restore.md) places retention outside the
  panel: `restic forget --dry-run` first, then a serialized prune with a separate
  administration credential, protecting the last verified recovery point and
  never running concurrently with a backup or a restore proof.
- The managed-site plan requires prune impact to be measured before any
  retention automation. Today the operator runs `forget --dry-run` by hand from
  the maintenance host, with no declared policy in the panel and no link to the
  facts the panel already records (last attempt, last good snapshot, last
  verified restore).
- Restic warns that a policy-based `forget` on an append-only repository can be
  steered by injected snapshots: an attacker who can only append can place
  timestamps that displace legitimate snapshots. The measured removal set,
  including whether it contains the last verified recovery point, is the
  operator's main defence.
- The panel must stay a single Bun process with no scheduler and no deletion
  credential. Measuring is a read; deleting is not.

## Decision

### Manifest: one optional `retention` inside `backup`

```json
"backup": {
  "kind": "restic",
  "repository": "rest:https://backup.example.test/acme-shop",
  "retention": { "keepLast": 7, "keepDaily": 14, "keepWeekly": 8, "keepMonthly": 12 }
}
```

- `backup.retention` is optional, `managed` only (the `backup` block already is)
  and lives in manifest `version: 3`. It has at most four fields, all optional:
  `keepLast` (1–100), `keepDaily` (1–365), `keepWeekly` (1–104) and
  `keepMonthly` (1–120). At least one field is required; an unknown field, a
  non-integer, zero or an out-of-range value is refused.
- The block is declarative only. It authorizes no deletion and changes no
  generated file: generator and Compose output stay byte-identical. Removing it
  removes the preview button on the next request.
- The panel passes the declared values to Restic unchanged. It does not
  reimplement Restic's calendar policy in TypeScript, so the preview cannot
  drift from the tool that would eventually run.

### One read-only preview operation

- `POST /stacks/<stack>/backup/retention` is a browser action with the normal
  Origin, CSRF and session checks. It is not a machine route, takes no token and
  is not reachable without a session.
- It starts one operation with action `retention-preview` under the per-stack
  lock, so it cannot overlap a backup, a restore proof, a deploy or another
  preview. The existing admission still applies: a pending deploy marker, a
  pending backup marker, a missing backup block or missing credential files
  refuse the preview with nothing run.
- The run re-reads the manifest and the credential metadata under the lock, then
  runs two fixed one-shot Restic commands with the pinned image, a read-only
  root filesystem, a bounded tmpfs, the operator-owned password file and the
  optional REST environment file. No site data is mounted:

  ```text
  restic snapshots --json --no-lock --tag site:<siteId>
  restic forget --dry-run --json --no-lock --tag site:<siteId> --keep-…
  ```

- `--dry-run` is mandatory and `--prune` is never passed. `--no-lock` is used
  because the panel holds the stack lock and an append-only repository must not
  accumulate lock objects it cannot delete; an external concurrent prune is the
  operator's own procedure and is documented as non-overlapping.
- The output is bounded (2 MiB, five minutes) and validated before it is shown:
  every returned snapshot needs a 64-hex id, an ISO timestamp and the site tag;
  every filtered snapshot must appear exactly once in the union of `keep` and
  `remove`. An unknown id, a duplicate, a missing snapshot or an unfamiliar
  shape refuses the preview rather than showing a partial removal set.
- The operation prints the declared policy, the totals and the exact removal
  ids. It never prints the repository password, the REST environment, the
  repository URL or any file content.
- If the removal set contains the recorded last good snapshot or the last
  verified restore snapshot, the operation says so. The facts are never
  rewritten by a preview, and the panel does not block the operator: the
  warning is the point.

### No deletion, no credential, no schedule

- The panel gains no `forget` without `--dry-run`, no `prune`, no
  `--unsafe-allow-remove-all`, no snapshot id argument and no maintenance
  credential. The preview uses the existing append-only backup credential and
  fails closed if the repository refuses the read.
- The real `forget`/`prune` stays an operator procedure on the separate
  maintenance host, followed by `restic check` and a restore proof. The preview
  is advisory: it tells the operator what that procedure would remove.
- No preview is stored as a durable fact. It is operation output with the same
  retention as any other operation, and losing it costs nothing. There is no
  timer, retry, notification or automatic prune.
- Every preview records `backup` with action `retention-preview`, the network
  client key, the stack, the coarse result and the keep/remove counts. It never
  records a snapshot id, a policy reason or repository output.

## Consequences

- The operator can measure prune impact from the site page, with the same
  declared policy that the maintenance host will use, under the same stack lock
  as every other backup action, without holding deletion credentials in the
  panel.
- The panel gains one optional manifest field, one module, one operation action,
  one route and one card subsection. It gains no dependency, no deletion path,
  no scheduler and no second credential.
- A preview is not proof: it is not a retention run, not a restore proof and not
  a substitute for the off-panel prune and `restic check`. The real-host
  checklist covers one preview compared with one real off-panel prune.
- Retention automation still needs its own ADR, deletion credentials, a dry-run
  safeguard and a protected recovery point. This ADR deliberately stops before
  that line.

## Alternatives considered

- **Prune from the panel with the backup credential.** The append-only endpoint
  refuses deletion, and giving the panel a writable maintenance credential would
  defeat that protection; rejected.
- **A second deletion credential inside the panel.** Stores a destructive
  credential in the same process that serves the web UI, and contradicts ADR
  0049's separation; rejected.
- **Reimplement the keep-daily/weekly/monthly policy in TypeScript.** Would
  diverge from Restic's calendar and grouping rules, so the preview could
  disagree with the real prune; rejected.
- **Run `prune --dry-run` instead.** It measures reclaimed data but not which
  snapshots disappear, which is the decision the operator has to make; rejected
  as the primary signal.
- **Store the last preview as a durable fact.** Adds state that can go stale and
  would look like a retention decision; operation output is enough.
- **Refuse the preview when it would remove the last verified restore.** That
  hides the exact impact and blocks an operator who knows the policy is wrong;
  a prominent warning is strictly more informative.

## Verification

- Unit tests: the `retention` block (at least one field, each bound, unknown
  field, non-integer, zero, a non-object), the exact argument list (always
  `--dry-run` and never `--prune` or `--unsafe-allow-remove-all`), inventory
  parsing (valid, foreign tag, malformed id or time, duplicate id, bound), the
  preview parser (array and single group, unknown shape, id absent from the
  inventory, duplicate across `keep` and `remove`, every inventory snapshot
  accounted for) and the protection helper.
- App tests: CSRF and origin are required, a site without `retention` is
  refused, a pending marker refuses, one preview starts one operation under the
  lock, the recorded calls are exactly `snapshots` and `forget --dry-run`, no
  call carries `prune`, and an inconsistent reply fails without showing a
  removal set.
- Implemented on 2026-11-25. The full unit and app suite passes on Windows and
  Linux. The disposable REST fixture runs the same preview against the
  append-only lab repository, and its prune attempt still leaves the snapshot
  listed; the panel never deletes.
- Real host: part of
  [deployment.md](../deployment.md#remaining-real-host-validation). Run one
  preview, compare its removal set with one off-panel `forget --prune`, run
  `restic check`, and restore the remaining protected snapshot.

## Out of scope

Automatic or panel-run prune, snapshot deletion, a deletion credential,
retention scheduling, notifications, `keep-hourly`, `keep-yearly`,
`keep-within-*`, `keep-tag`, `--unsafe-allow-remove-all`, deleting a named
snapshot, and any retention decision the operator has not declared.
