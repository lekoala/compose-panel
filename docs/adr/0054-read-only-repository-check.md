# ADR 0054 - Check the backup repository without changing it

Status: Accepted (managed-site pilot, 2026-11-25). Implemented in the same
change; the real-host checklist remains.

## Context

- [ADR 0053](0053-read-only-snapshot-inventory.md) lets the operator choose the
  exact snapshot id to restore, but it proves nothing about the repository
  holding it. A snapshot can be listed while a pack file is damaged, and the
  restore proof (ADR 0049) only reads the files of the one snapshot it extracts.
- Today the only way to learn whether a repository is intact is `restic check`
  on the maintenance host. That hides the answer behind SSH access, a second
  Restic installation, the right repository address and the right password file,
  exactly where a typo or the wrong site is likely.
- A repository check is a read: it opens the repository, verifies its structure
  and can read pack data. It needs no deletion credential, writes nothing and
  cannot repair anything. [ADR 0052](0052-retention-preview.md) already runs
  the pinned Restic client against the same repository for a dry-run, so the
  tooling, credentials and bounded parsing exist.

## Decision

### One operation, started from the site card

- `POST /stacks/<stack>/backup/check` starts one `repository-check` operation.
  It exists only for a managed site with a `backup` block, only when managed
  sites are enabled, and only with a session, the CSRF token and an allowed
  Origin, like every other operation.
- It is a POST, not a link, because it holds the stack lock and may run for
  minutes. A GET could be triggered by a prefetch or a reload, and the operator
  must ask for it explicitly.
- It takes the same per-stack lock as a backup. A check that overlapped a panel
  upload could see packs appear mid-run and lose the meaning of its answer; one
  modifying or measuring operation per stack stays the rule. The lock cannot see
  an external Restic run, so one repository operation at a time remains the
  documented operator procedure.
- It refuses before any container runs when the manifest is unusable, the site
  is not `owner: managed`, there is no `backup` block, the credential files are
  missing or mis-owned, a deploy attempt is pending, a backup attempt has an
  unconfirmed outcome, the panel is updating itself or it is shutting down.

### One fixed command

- The operation runs one one-shot command with the pinned Restic image, a
  read-only root filesystem, a bounded tmpfs, the operator-owned password file
  and the optional REST environment file:

  ```text
  restic check --no-lock --read-data-subset 32M
  ```

- `--no-lock` is required for the same reason as the preview and the inventory:
  the panel holds no deletion credential and an append-only repository must not
  accumulate a lock object the panel cannot remove. The stack lock already
  serializes this panel's own operations.
- `--read-data-subset 32M` makes Restic read a random 32 MiB of pack data in
  addition to the structure, so a small repository is read whole and a large one
  is sampled. The panel never passes `--read-data`, so it never claims a full
  data verification. The upper bound matters because the check runs inside a
  container whose temporary cache lives in tmpfs.
- The command has its own bounded timeout (five minutes) and output cap
  (256 KiB). A timeout or a truncated reply is a failure that claims nothing
  about the repository, not a partial success.

### Only Restic's own answer is accepted

- A success requires exit code 0 **and** Restic's own final confirmation that
  no errors were found. A zero exit without that line is refused rather than
  reported as a clean repository, because a changed or wrapped client must not
  be able to turn silence into a green result.
- The failure messages are fixed per documented exit code: repository errors,
  repository missing, repository locked, wrong password, or an unknown code.
  Neither stdout nor stderr is rendered: they name pack files and print repair
  commands the panel cannot and must not run. The panel keeps no repair command,
  no lock removal and no `unlock`.
- An initialized repository with no objects is not reported as damaged. Restic
  refuses to read a zero-size repository, so the panel returns a fixed "nothing
  to check" message. A wiped repository looks identical, so the operator
  confirms from the maintenance host rather than trusting a calm answer.
- The result states exactly what was checked: the repository structure plus a
  random 32 MiB data sample. A full `restic check --read-data` and a real
  restore proof stay operator procedures on the maintenance host.
- Nothing durable is written. No "last checked" fact, no file, no cache and no
  change to `trigger-state.json`; a check is not a restore proof and must not
  be mistaken for one.

## Consequences

- The operator can tell a broken repository from a healthy one without leaving
  the panel, before choosing a snapshot to restore or pruning from the
  maintenance host.
- The panel gains one POST operation, one pinned Restic read and one fixed
  result sentence. It gains no credential, no deletion, no repair, no stored
  fact and no scheduler.
- A check consumes repository bandwidth and holds the stack lock for its
  duration; the timeout bounds the run and the operator chooses when to spend
  it. A large repository may need a full check on the maintenance host anyway,
  which stays documented.
- The disposable lab can prove the command on an append-only REST repository;
  a real endpoint, a large repository and a real damaged repository remain in
  the real-host checklist.

## Alternatives considered

- **Run the check as part of the backup.** It would lengthen every backup,
  re-read data the upload just wrote and turn an optional assurance step into a
  mandatory one; rejected.
- **Add a durable "last checked" badge.** It would need a new stored fact and
  would imply a freshness guarantee the panel cannot make; the operation output
  is the honest place for the answer; rejected.
- **Use `--read-data` for a complete proof.** It is unbounded in time and
  bandwidth and cannot fit a five-minute interactive operation; the maintenance
  host keeps that job; rejected.
- **Render Restic's stderr on failure.** It names pack files and prints repair
  commands, inviting the operator to run a repair from the panel host; a fixed
  message that points to the maintenance host is safer; rejected.
- **Use a GET page like the snapshot inventory.** The inventory is a bounded
  read of metadata with no lock; a check can run for minutes and holds the lock,
  so it must be an explicit operation; rejected.

## Verification

- Unit tests cover the fixed arguments, the absence of `forget`, `prune`,
  `--read-data`, `unlock` and any snapshot id, the success confirmation, the
  documented exit codes, the empty-repository message, a timeout, truncated
  output, a zero exit without the confirmation and a site without a backup block
  (no container).
- App tests cover the session and Origin checks, a stale CSRF token, a site
  without a backup block, missing credentials, a pending deploy, a pending
  backup, a successful operation, the card entry point and a failure that
  claims nothing. A refused request runs no container.
- The disposable REST fixture runs the real module against the append-only lab
  repository after two backups, requires a clean result, and proves that the
  repository lock directory and the snapshot list are unchanged. Run on
  2026-11-25: `wsl -- bash scripts/managed-sites-e2e/run.sh -t "backs up to an
  append-only REST repository"` → 1 pass, 0 fail, 19 assertions. A corrupted
  repository is not manufactured on the lab server; the failure path stays
  unit-tested.
- Still open: the real-host checklist. The check is proven on the disposable
  lab, not against a real endpoint, a large repository or a damaged one.
