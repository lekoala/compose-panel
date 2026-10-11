# ADR 0017 — Backup retention and manual purge

Status: accepted.

## Context
ADR 0004 copies the previous `compose.yaml`/`.env` to
`<root>/.compose-panel/backups/<stack>/` before every save and left retention
open. Backups therefore grew without bound, and `.env` backups kept old secrets
on disk indefinitely, even after a secret was rotated in the live file. The
activity log already has a retention (`COMPOSE_PANEL_AUDIT_RETAIN_FILES`); backups
had none and no way to remove them except by hand on the host.

## Decision
- **Automatic retention.** After a save that changed files, the panel keeps the
  `COMPOSE_PANEL_BACKUP_RETAIN` (default 10) most recent backups *of each file*
  (`compose.yaml` and `.env` counted separately) for that stack and deletes the
  older ones. Pruning runs under the stack lock, after the write. A pruning
  failure is logged without file contents and never turns a successful save
  into an error.
- **Manual purge.** The edit page shows how many backups a stack has and their
  total size, with a "Delete all backups" action behind a `<details>` confirmation
  (no JavaScript needed). `POST /stacks/<name>/backups/purge` requires a session,
  an allowed Origin and the CSRF token, like every mutation. It validates the stack
  through `locateComposeFile`, runs under the same per-stack lock as saves and
  operations (refused with 409 while one is running), is refused during shutdown,
  and is recorded in the activity log as `backup-purge`.
- **What counts as a backup.** Only regular files named exactly as `backupFile`
  writes them (`<file>.<UTC timestamp>.<18 hex>`) are listed, counted or deleted.
  Other files in the folder, directories and symlinks are ignored. Every folder
  component is lstat-checked as for backup creation; deletes use `unlink`, which
  never follows a symlink.
- The live files are never touched by retention or purge.

## Why
- A count per file is predictable and needs no clock or date parsing; it also
  keeps recent `compose.yaml` history even when `.env` changes often (or never).
- A manual purge is the honest way to get rid of an old secret now, instead of
  waiting for N more saves.
- Matching the exact filename format keeps the panel from deleting anything it
  did not create (invariant: no arbitrary file manager).

## Consequences
- Older versions beyond the retention count are gone; operators wanting a longer
  history must keep host-level backups (see `docs/deployment.md`).
- Retention applies on the next save: lowering the setting does not prune
  stacks that are not saved again; the manual purge covers that case.
- A purge is irreversible and deletes all backups of one stack; there is no
  per-file selection or download in the UI.
