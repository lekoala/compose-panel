# ADR 0049 — Offsite backup and tested restore

Status: Accepted (managed-site pilot, 2026-11-25). Backup implemented; the
restore slice, the disposable Restic fixture and the real-host checklist remain.

## Context

- ADR 0042/0043 deploy and roll back immutable releases, and ADR 0048 attaches
  one existing database. Neither protects the data: uploads in `shared/` and the
  site's database live outside Git and outside the release pointer. A deploy
  failure is recoverable; a deleted upload or a dropped table is not.
- The pilot's recovery story is currently a local pre-edit copy of
  `compose.yaml`/`.env` (ADR 0017). That is not an application snapshot: it
  keeps no application data, no database dump and no off-host copy.
- The plan's next increment is a manual backup and a tested restore, before any
  timer or retention automation. A backup that has never been restored is a
  claim, not a capability.
- The contract must stay generic: MariaDB, MySQL and PostgreSQL are the
  database-attachment allow-list, and a site may have no database at all. Only
  the dump adapter is engine-specific; the file half and the snapshot format do
  not depend on the engine, the framework or the application layout.
- The panel must not become a general SQL client, a database proxy, a backup
  server or a credential store. It may only run fixed, bounded, one-shot
  commands with explicit argument arrays.

## Decision

### Scope

- One operator-triggered **Backup now** action per site, and a separate restore
  proof. Both take the existing per-stack lock, so a backup and a deploy or
  another backup cannot interleave. There is no scheduler, no webhook, no
  background queue and no automatic retry.
- One offsite backend: a Restic repository reached over the REST protocol. The
  target is a dedicated TLS endpoint in append-only mode; the repository is
  configured per site, and distinct repositories and credentials per site are
  the operator's contract. A backend that cannot enforce append-only is a
  documented weaker mode: it protects against disk loss, not against a
  compromised host deleting snapshots, and must not be described as
  ransomware-resistant.
- The panel gains: a manifest block, fixed private credential files, a staging
  area, a snapshot manifest, an attempt marker and the two fixed one-shot
  commands. It gains no runtime package dependency, no Docker socket mount, no
  arbitrary command and no SQL console.
- The first increment covers `owner: managed` sites only, because their
  persistent roots are the declared `paths` of ADR 0042. An opt-in stack has no
  such declaration, so backing it up would require a new operator-authored data
  scope; that is out of scope here rather than guessed from its Compose file.
- Out of scope: scheduling and timers, retention/prune automation, incremental
  file watching, database provisioning, migrations, cross-site repositories,
  restore over the live site, cloning a site, notifications, backup of the
  panel itself, and opt-in backup scopes. Each needs its own ADR or vertical PR.

### Manifest: version 3 and one `backup` block

- New optional `backup` block, only in manifest `version: 3`:

  ```json
  "backup": {
    "kind": "restic",
    "repository": "rest:https://backup.example.test/acme-shop",
    "sql": { "engine": "mariadb", "database": "acme_shop" }
  }
  ```

  - `kind` is an allow-list with one value now, `restic`.
  - `repository` is a bounded URL, never a command, path, credential or free
    text. `rest:https://` is accepted anywhere; `rest:http://` is accepted only
    for a loopback host or a single-label Compose service name, so a disposable
    lab can use a private network while a real deployment is TLS-only. No
    userinfo, query string or fragment; explicit host and simple path segments;
    at most 512 characters.
  - `sql` is optional. Omitted means a files-only backup, which is valid for any
    site. When present, it requires `database` and its `engine` must equal the
    declared engine. The first adapter is `mariadb`; MySQL and PostgreSQL
    declarations are refused until their bounded adapter ships, rather than
    advertised as working.
  - `database` is the exact database name to dump, a bounded SQL identifier
    (letters, digits, `_`, `$`, at most 64 characters, not starting with `-`).
    It is passed as one explicit argument, so the dump never selects another
    site's database.
- Versions 1 and 2 stay valid and unchanged. A v3 manifest is a v2 manifest
  plus the optional `backup` block. The block changes no generated file: the
  generator version stays `1` without a database and `2` with one, and Compose
  output is byte-identical.
- The backup block is part of the effective admission: a site with a malformed
  or unsupported block refuses backup and restore with an actionable reason.
  Deploy, Up and the other existing actions are unaffected, because a backup
  misconfiguration must not take a working site down.

### Fixed private files

- Backup credentials live under the fixed directory `<stack>/site/private/backup/`,
  mode `0700`, owned by the panel account, outside releases, `generated/`,
  `public/` and every service mount:
  - `restic-password`: the repository encryption password.
  - `rest.env`: optional REST basic-auth variables, read by Restic through
    `env_file`.
  - `database.env`: the **backup** database role, read by the dump client.
    It uses the client's own documented variables (`MYSQL_HOST`,
    `MYSQL_TCP_PORT`, `MYSQL_USER`, `MYSQL_PWD`), not application variable
    names, so the attachment contract (ADR 0048) is not reopened. The operator
    provisions a read-only role, distinct from the application account.
- Each file must be a regular file, not a symlink or hard link, owned by the
  panel account, mode `0600`, and bounded (4 KiB each). The panel checks these
  metadata and the directory before a backup; it never reads, parses, logs or
  renders the values. The file names are fixed, not manifest-configurable.
- The repository password and an independently usable recovery credential are
  kept off the host. The operator must be able to restore with the VPS
  credentials unavailable. The panel never generates, rotates or exports a
  credential.
- The panel's backup credential is write-only for backups: it must not be the
  retention/administration credential. Pruning uses a separate credential,
  outside the panel.

### One-shot tooling

- Two pinned images, pulled by explicit reference and never built by the panel:
  a Restic client image and the engine's dump image (initially `mariadb:11`,
  which ships `mariadb-dump`). Both are one-shot containers, not panel
  dependencies and not site services.
- Every invocation is a fixed executable name and an explicit argument array.
  No `sh -c`, no user input in an argument position, no inherited environment
  beyond the fixed allow-list, no Docker socket, no privileged mode, no host
  network.
- The Restic container reads the staging tree and the fixed credential files,
  and writes only to the repository endpoint. Read-only root filesystem and a
  bounded tmpfs are required where the image allows it.
- The dump container joins only the declared database external network. It
  receives `database.env` as an `env_file`, never the application env file, and
  runs one bounded `mariadb-dump` for the one declared database with
  `--single-transaction --quick --skip-lock-tables --routines --events
  --triggers --databases <name>`. No `--all-databases`, no `--tab`, no
  interactive client, no arbitrary statement. Its stdout is the only file it
  writes, into the private staging area.
- Both containers have a fixed timeout, a captured-output cap and a hard size
  cap on what they may produce. A timeout, a non-zero exit, a truncated dump or
  an oversized dump fails the attempt before anything is uploaded.

### What a snapshot contains

- A pre-copy step walks each declared persistent root (`paths`, ADR 0042) with
  no-follow semantics and refuses symlinks, hard links leaving the root, sockets,
  devices, FIFOs, escaped paths, too many entries or more bytes than the
  configured staging quota. The declared roots are copied into a private
  staging directory, so Restic never walks a changing live tree.
- The SQL half, when declared, is written as one `database.sql` in the same
  staging directory, after the file copy. The dump and the file copy therefore
  have a measurable capture window, not a shared point in time.
- `backup.json` (bounded) records: manifest and backup schema versions, site ID,
  the release SHA served by `current` and the runtime image reference with its
  resolved image ID, the engine and dump-client reference, the database name,
  the backup mode (`files` or `files+sql`), the staging inventory (relative
  path, type, size, SHA-256, bounded entry count), capture start/end times,
  consistency mode, and the exact command options used.
- Excluded by construction: releases and code (reproducible from Git), caches,
  `generated/`, `.env`, every `site/private/` credential, Docker state and
  unrelated data. A declared root that contains a credential directory is
  refused rather than silently included.
- The snapshot is accepted only when the dump and the upload both exited
  successfully, Restic returned exactly one snapshot ID, and
  `restic snapshots --json` read back that ID with the expected tags and
  `backup.json` inside. A partially uploaded or unverifiable snapshot is never
  recorded as good.

### Attempt marker, failure and rollback

- A backup writes `site/private/backup-attempt.json` before the first container
  starts, with attempt ID, phase and `pending` outcome. The marker is cleared
  only after the accepted snapshot ID is recorded.
- A crash may leave an unknown outcome. The next backup and restore are refused
  until the operator inspects the repository and acknowledges that attempt.
  There is no automatic replay, exactly as for a deploy (ADR 0043).
- A failed backup never touches the live site: no release, pointer, container,
  database row, upload or generated file changes. Last good snapshot and the
  existing pointer stay as they were.
- Staging is removed only after its device/inode identity is compared with the
  one created by the attempt, and only when the attempt is proven failed or
  accepted. A partial staging tree is private (`0700`) and is not reused.
- Backup does not run while a panel operation holds the stack lock, and every
  modifying operation is refused while a backup holds it. The panel stack lock
  does not stop application writes; that is why consistency is recorded instead
  of claimed.
- The panel records the attempt and its outcome in the audit trail. A snapshot
  ID in an audit line is not a recovery journal and is never used as one.

### Restore

- Restore is a separate vertical PR after the backup PR. It is read-only against
  the live site.
- The operator selects one **exact** snapshot ID from the site's repository;
  `latest` is refused. The panel verifies the repository identity, the site ID
  in `backup.json`, the schema version, the engine and dump-client compatibility
  and the inventory before extracting anything.
- Files are extracted into a new private directory under
  `site/private/restore/<attemptId>/`, mode `0700`, never over `shared/`, a
  release or the pointer. The panel reports which components completed and
  leaves a partial restore in place, private, for inspection.
- The SQL half is imported into a **new disposable** instance of the same
  engine with a compatible version: no production credentials, no production
  network, no published port, no volume from the site. The panel runs the
  fixed import and one bounded verification (the import exited successfully and
  the declared database contains at least one table), never an arbitrary query.
- Restore never overwrites the live database or live uploads. Moving a verified
  restore into the live site stays an operator procedure over SSH in this ADR;
  an automated live restore needs its own ADR because it is a destructive
  mutation with a new failure boundary.
- A restore is recorded as a proof only when a protected file and its
  corresponding database record are both readable from the restored copy, and
  the live database and a neighbouring site's database are unchanged.
- Expiry and resource IDs of the disposable instance are recorded, and cleanup
  is explicit and scoped to the resources the attempt created, by name and
  identity. A failed cleanup is reported, not hidden.

### Retention and scheduling

- Retention runs outside the panel with the separate administration credential:
  `restic forget --dry-run` first, then a serialized prune, protecting the last
  verified recovery point and never running concurrently with a backup or a
  restore proof.
- A host systemd timer that requests the same guarded backup (same stack lock,
  admission and one-process model) is a later ADR. The panel never starts its
  own scheduler, and a missed run is reported as overdue rather than silently
  retried.
- Last attempt, last good snapshot and last successful test restore are three
  distinct facts and are displayed as such.

## Consequences

- A site's data becomes recoverable without the host: uploads and, when
  declared, one database dump exist in an offsite repository, and the restore
  proof demonstrates that the copy is usable.
- The operator gains provisioning work: one repository per site, one backup
  role, two or three fixed credential files, an off-host recovery credential, an
  append-only endpoint and a retention procedure.
- The panel gains a manifest block, a metadata-only credential check, a bounded
  staging walk, two one-shot container launchers, a snapshot manifest, an
  attempt marker and a restore proof. It gains no scheduler, no SQL client in
  the panel image, no backup server and no retention credential.
- The first slice is managed-only and MariaDB-only for SQL. A MySQL or
  PostgreSQL adapter is a bounded change to the dump container and the same
  snapshot contract; files-only backup works for every engine from the start.
- The backup is not point-in-time across files and SQL, and not consistent for
  non-transactional tables. The recorded window and mode make that honest; a
  quiescence procedure remains an operator decision.
- This ADR amends ADR 0042's manifest version bound (1 or 2 becomes 1, 2 or 3)
  and adds a `backup` field, in this slice. It does not change ADR 0048's
  attachment contract.

## Alternatives considered

- **Back up the whole stack directory.** Includes credentials, code, caches and
  unrelated data; rejected.
- **`docker commit` or volume snapshots.** Ties recovery to the engine's storage
  layout, is not portable off-host and captures no logical database state;
  rejected.
- **A panel-side SQL client or a general dump console.** Makes the panel a SQL
  client and a credential store; rejected. Only fixed one-shot adapters run.
- **`restic` inside the panel image.** Couples the panel release cycle to the
  backup client and widens the panel image for an occasional operation;
  rejected in favour of a pinned one-shot container.
- **Automatic retention from the panel.** The panel would need deletion rights
  on the repository, which defeats append-only protection; rejected.
- **Restore directly over the live site.** A destructive mutation with a new
  failure boundary; needs its own ADR. The first restore proves the copy in
  isolation.
- **A scheduler in this increment.** It would hide an unproven restore behind
  automation; rejected until a restore proof passes.
- **Backing up every database on the server.** Crosses the site boundary and
  captures other tenants' data; rejected.

## Verification

- Implemented and unit-tested on 2026-11-25: manifest v3 parsing, repository URL
  and identifier bounds, the engine/`database` coupling, credential metadata,
  no-follow staging with quotas and checksums, the attempt marker, the fixed
  MariaDB dump and Restic argument arrays (with a fake runner), snapshot-output
  parsing and the app route/admission/acknowledgement. The operation never
  reads a credential value, and a refused admission runs no container.
- Still open: the disposable Restic fixture (append-only REST endpoint, MariaDB,
  a real upload and a restore proof) and the restore slice itself. Run the
  fixture before calling the backup production-proven.
- Unit tests: v3 parsing, v1/v2 compatibility, repository URL and identifier
  bounds, engine/`database` coupling, credential file metadata, no-follow
  staging walk and quota, refusal of credentials inside a declared root,
  attempt-marker transitions and no automatic replay, snapshot-manifest bounds,
  restore compatibility refusals, and no credential in output, HTML or audit.
- Disposable lab, before any scheduling or retention work: a Restic REST server
  in append-only mode, a MariaDB instance, and one managed site. Write one file
  and one database row, run the backup, delete the file and alter the row, then
  restore into a new private staging directory and a new disposable database.
  Read the file and the record back. Assert that the live database and a
  neighbouring site's database are unchanged, that the append-only credential
  cannot delete a snapshot, and that a foreign snapshot ID, a wrong repository
  password, an oversized staging tree, a partial dump and an unsafe path are
  refused before acceptance.
- The same disposable suite proves the downgrade path: a failed backup leaves
  the pointer, release, containers and data untouched, and the attempt marker
  refuses the next run until acknowledged.
- Real host: part of the checklist in
  [deployment.md](../deployment.md#remaining-real-host-validation). Complete one
  recovery from a separate machine with the VPS credentials unavailable, and
  record measured RPO/RTO for the tested mode.
- Passing the lab is not production proof: append-only semantics, TLS endpoint
  policy and the recovery credential's independence must be verified on the real
  endpoint before backups are treated as operational.

## Out of scope

Scheduling, timers, retention automation, snapshot deletion from the panel,
backup of the panel itself, live restore, cloning, notifications, backup
encryption key management beyond the operator's off-host credential,
cross-site repositories, MySQL/PostgreSQL dump adapters, and any general SQL
console or query interface.
