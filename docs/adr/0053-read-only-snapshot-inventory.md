# ADR 0053 - Choose a restore snapshot from a read-only inventory

Status: Accepted (managed-site pilot, 2026-11-25). Implemented in the same
change; the real-host checklist remains.

## Context

- [ADR 0049](0049-offsite-backup-and-restore.md) restores one **exact**
  64-character snapshot id and refuses `latest`. The panel shows an empty text
  field, but the only way to learn an id today is to run `restic snapshots`
  from the maintenance host. That second path risks the wrong repository, a
  wrong site tag or a transcription error, and the operator repeats it before
  every restore proof.
- The panel already reads this site's tagged inventory for the retention
  preview ([ADR 0052](0052-retention-preview.md)) with the pinned Restic client
  and a bounded parser. Showing the same inventory is a read, not a new
  capability: it deletes nothing, stores nothing, adds no credential and does
  not change the restore contract.
- A repository read is still a privileged read: snapshot ids and timestamps
  describe the site's backup history. The page needs the same session, Host
  allow-list and metadata-only credential checks as the existing backup views.

## Decision

### One read-only page

- `GET /stacks/<stack>/backup/snapshots` is an ordinary authenticated page. It
  exists only for a managed site with a `backup` block and only when managed
  sites are enabled. There is no machine route and no new token.
- A read-only GET needs no CSRF token because it changes no state. The Host
  allow-list, the session check and `no-store` headers still apply, and the page
  is reached only from the stack card.
- The page refuses before running anything when the manifest is unusable, the
  backup credentials are missing or mis-owned, a deploy attempt is pending, a
  backup attempt has an unconfirmed outcome, the panel is updating itself or it
  is shutting down. A refusal shows the existing reason, never a partial list.

### The same inventory call as the preview

- The page runs one fixed one-shot command with the pinned Restic image, a
  read-only root filesystem, a bounded tmpfs, the operator-owned password file
  and the optional REST environment file:

  ```text
  restic snapshots --json --no-lock --tag site:<siteId>
  ```

- It reuses the inventory argument builder and parser of the retention preview:
  only snapshots carrying this site's tag, one 64-hex id each, a parseable RFC
  3339 timestamp, at most 2000 snapshots and no partial result. A malformed,
  duplicated or foreign reply fails the page instead of being filtered.
- `--no-lock` is used for the same reason as the preview: the panel holds no
  deletion credential and an append-only repository must not accumulate lock
  objects it cannot remove. The read does not take the stack lock because it
  mutates nothing; it may run while a backup uploads, and the page never claims
  the list is a recovery point.
- The command has its own bounded timeout and output cap. The page renders only
  the id and Restic's timestamp, newest first. It renders no path, tag, hostname,
  size, repository URL or raw JSON, and it stores no list and no cache.

### Choosing a snapshot

- Each row links to `/stacks/<stack>?snapshot=<id>`, which pre-fills the existing
  exact-id field after the value passes the same 64-hex check. An invalid or
  foreign query value is ignored, not reflected.
- The list never starts a restore. The operator still submits the existing form,
  which re-reads the manifest, the credentials and the exact snapshot under the
  operation admission before extracting anything.

## Consequences

- The operator no longer needs a Restic client on the panel host to choose a
  restore snapshot, and a typo or a wrong-site id is less likely. The restore
  contract is unchanged: one exact id, verified against this site's repository
  before extraction.
- The panel gains one GET page, one bounded repository read and one pre-filled
  form value. It gains no credential, no deletion, no stored list, no cache and
  no second backup path.
- Snapshot history stays metadata: the page shows ids and timestamps only.
  Reading a snapshot manifest, browsing its files, deleting a snapshot and
  measuring retention remain separate operations (ADR 0049, ADR 0052).

## Alternatives considered

- **Show the list inside the retention preview operation.** It mixes a policy
  measurement with a restore chooser, needs a successful dry-run, and turns a
  read into an operation; rejected.
- **Cache the list between page loads.** A stale id invites the operator to pick
  a snapshot that no longer exists; the extra daemon call is cheap and bounded;
  rejected.
- **Let a list row start the restore directly.** It removes the operator's
  explicit confirmation of the exact id and creates a second restore entry
  point; rejected in favour of pre-filling the existing form.
- **Run `restic ls` for every row.** It is unbounded and unnecessary to choose
  an id; the restore already verifies the manifest and every file; rejected.

## Verification

- Unit tests cover the shared inventory arguments and parser, the newest-first
  order, the empty list, the failure reasons and the refusal of a foreign,
  duplicated, malformed or oversized reply. The module never passes a snapshot
  id, `forget`, `prune` or a deletion flag.
- App tests cover the session and Host checks, a missing backup block, missing
  credentials, a pending deploy, a pending backup, a successful bounded list,
  the per-row link, the pre-filled restore field and the ignored invalid value.
  A refused page runs no container.
- The disposable REST fixture lists the two snapshots written by the backup
  proof, newest first, while a snapshot tagged for another site is absent. The
  append-only repository is unchanged by the read.
- Still open: the real-host checklist. The page is proven on the disposable lab,
  not against a real endpoint or an operator credential.
