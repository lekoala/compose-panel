# ADR 0048 — Attach a site to an existing database

Status: Accepted (managed-site pilot, 2026-11-25). Implemented and proven on
the disposable lab on 2026-11-25; the real-host checklist remains to be run.

## Context

- The managed-site pilot deploys and rolls back application releases, but it has
  no database contract. A typical site needs a database; the panel must not
  become a SQL client, a database proxy or a credential store (ADR 0027,
  [product.md](../product.md)).
- ADR 0043 refuses any service that joins an external network. That protects the
  site's project isolation, but it also blocks the normal case: one
  operator-managed database shared by several sites, each with its own database
  and account.
- The plan's next increment is one pre-provisioned database server. The first
  fixture uses MariaDB because the original pilot proof did; the attachment
  itself is engine-neutral. MariaDB, MySQL and PostgreSQL are the initial
  allow-list: the network and env-file checks are identical, and only a later
  backup adapter is engine-specific.
- The contract is Compose-level and must not assume PHP. The pilot currently
  ships one runtime profile (`php-front-controller`); a second profile is a
  separate ADR. The declaration, network rule and env-file check are written so
  that a future Node, Python or static profile can reuse them without changing
  this contract. No framework, ORM, environment-variable naming or SQL client is
  part of the attachment contract; only a bounded engine name is recorded.

## Decision

### Scope

- One existing database server per site, of an allow-listed engine (MariaDB,
  MySQL or PostgreSQL), provisioned by the operator outside the panel. One
  database and one application account per site. The panel does not create,
  alter or drop anything.
- New panel behavior: parse and validate the declaration, include it in the
  effective-profile and drift checks, render the Compose fragment for
  `owner: managed`, and document the operator contract. The panel never opens a
  database connection, never runs a SQL client, never stores or renders a
  credential, and never reads the operator's env file directly.
- The existing `x-compose-panel.database` explorer link (ADR 0027) is
  independent; a site may have both. The link never carries a credential, and
  this attachment does not populate it.
- Out of scope: provisioning, dumps and restores, migrations, workers,
  connection pooling, credential rotation or UI, database health checks,
  cross-site sharing, backup/recovery credentials, and engine-specific SQL
  automation.

### Manifest and versions

- New optional `database` block, only in manifest `version: 2`:

  ```json
  "database": {
    "kind": "existing",
    "engine": "mariadb",
    "network": "acme-db"
  }
  ```

  - `kind` is an allow-list with one value now, `existing`.
  - `engine` is an allow-list: `mariadb`, `mysql` or `postgresql`. It is recorded
    for documentation and a future backup adapter; the attachment checks do not
    differ by engine.
  - `network` is the exact external Compose network name, bounded and validated
    as a network name. It is never a path, URL, command or credential.
- Version 1 stays valid and unchanged for sites without a database. A manifest
  that carries `database` must declare version 2; unknown fields still refuse.
  The parser accepts both versions. A v1 site opts in by setting `version: 2`,
  adding the block and regenerating; its releases, pointer and data are
  untouched.
- The generator version identifies the artifact shape: `1` is the no-database
  shape, `2` adds the database fragment. A site without `database` keeps
  generation `1` and byte-identical files. A site with `database` records
  generation `2`; the panel refuses a generation it does not know.

### Managed sites

- The generated Compose file adds, only when `database` is present:
  - to the runtime service: a Compose `env_file` entry for the fixed private
    path `<stack>/site/private/database.env`, and membership in the declared
    external network;
  - a top-level `networks.<name>` entry with `external: true` and the exact
    declared name.
  - The gateway never joins the database network. The engine does not change the
    fragment: only the network and the env file are generated.
- The env file is operator-provisioned at that fixed path. It must be a regular
  file, not a symlink, owned by the account that runs the panel, mode `0600`,
  under `site/private/` (outside releases, `generated/`, `public/` and every
  service mount). The panel checks existence, type, owner and mode before a
  mutation that starts the runtime. It never reads, parses, logs or renders the
  values.
- The file name is fixed, not configurable in the manifest: a free-form secret
  path is an attack surface and a drift source. The operator writes it once per
  site; a deploy does not touch it.
- If the file is missing or too permissive, Up, Pull + up, Start, Restart,
  Rollout and Deploy are refused with the path and the required mode. Reads,
  logs and regeneration remain available. The panel never creates the file and
  never generates a password.

### Opt-in stacks

- The operator owns the Compose file and may use any credential mechanism
  (`env_file`, Docker secrets or an external agent). The engine is declared for
  documentation and a later backup adapter; the panel does not connect. The
  panel validates only:
  - the declared runtime service exists and joins the declared external network;
  - that network is `external: true` and is the only external network in the
    project;
  - the pilot's existing network restrictions still hold: no other external
    network, no `network_mode: host` or `network_mode: service:` expansion;
  - the pre-provisioned database is not part of the project. The site's own
    services keep the ADR 0043 port rules (one loopback gateway port, no runtime
    port); the database's own exposure is the operator's responsibility.
- The panel does not read the operator's env file or secrets. It treats Compose
  configuration output as sensitive, as it already does for `.env`.
- These checks do not change the pilot's runtime profile requirement. A second
  runtime profile is out of scope and needs its own ADR; this ADR only keeps the
  attachment contract profile-neutral.

### Network and isolation (amends ADR 0043)

- ADR 0043's "no service joins an external network" becomes: no external
  network except the one declared by `database`, and only the runtime service
  joins it. The site's own project network remains the primary isolation
  boundary.
- The database network is shared by design. Tenant isolation is the database's
  grants, not Compose: the operator provisions one database and one application
  account per site and must prove account A cannot read B. The panel does not
  verify grants or claim isolation it cannot see.
- The pre-provisioned database stays private: it publishes no port reachable
  from untrusted networks. The panel validates the site's own configuration
  only; it does not inspect or modify the external database service.
- The panel does not join the database network. It only starts Compose commands
  that do.

### Deploy, failure and rollback

- The declaration is part of the effective profile and drift checks: a changed
  network, a runtime service that leaves the network, or a missing or loose env
  file refuses before any mutation.
- A deploy does not touch the database, run a migration or wait for it. A failed
  application connection is an application failure; it does not roll back the
  release. Rollback moves the code pointer; the database stays as it was.
- A first deployment still requires a provable baseline (ADR 0043). The database
  does not change that rule.
- No automatic retry, replay or secret regeneration is added.

### Security

- Credentials never appear in the manifest, generated files, releases, `.env`
  interpolation, logs, audit records or HTML. The env file sits outside every
  service mount; Compose reads it at container creation, it is not mounted into
  the container.
- `docker compose config` resolves env file values. The panel parses that output
  in memory and never logs, renders or publishes it. Failure messages are
  sanitized, exactly as for `.env` today.
- The panel image gains no database client. The application image owns its
  driver.
- The operator must treat the env file and any later dump as sensitive. Backup
  credentials are separate and belong to the backup ADR.

## Consequences

- Manifest version 2 and the new generation for database sites; v1 sites remain
  unchanged.
- One explicit eligibility exception in ADR 0043, scoped to the declared
  network.
- The manifest records a bounded engine name; adding an engine is a deliberate
  parser change, never free text.
- The deployment and security docs gain the operator contract and exact
  commands. Product, architecture and roadmap are updated when the ADR is
  accepted.
- The pilot remains default-off and the real-host checklist still applies. No
  new image dependency is introduced.

## Alternatives considered

- A database service in every generated site: duplicates capacity, upgrades,
  backups and credentials; rejected.
- Panel-provisioned databases, accounts or passwords: makes the panel a
  credential store and SQL client, outside the product; rejected.
- Reusing the ADR 0027 explorer link as the attachment: the link carries no
  runtime contract, network or credentials; rejected.
- A free-form list of external networks: widens isolation without a concrete
  need; rejected.
- Framework-specific env conventions or a migration runner: ties the product to
  one application shape; rejected.
- A MariaDB-only manifest: rejected because the attachment is engine-neutral;
  the operator chooses the engine and only the later backup adapter is
  engine-specific. The first fixture still uses MariaDB.
- Adding dump/restore now: needs its own client, credential and restore model;
  deferred to the backup ADR.

## Verification

- Unit tests: v1/v2 parsing, unknown fields, engine allow-list, network-name
  validation, generation and drift, runtime network membership, refusal of any
  other external network, env file stat checks, and no secret in output or HTML.
- Disposable lab: a pre-provisioned MariaDB (the first engine) on a private
  network, two sites with separate databases and accounts, site A unable to read
  B, a PHP fixture writing a record, deploying two releases, rolling back and
  reading it back, a failed connection that does not roll back the release, a
  missing or loose env file refused before mutation, the gateway absent from the
  database network, and no published database port. The same attachment checks
  apply to MySQL and PostgreSQL; a fixture per additional engine is added before
  that engine is advertised as proven, not speculatively. A Node or Python
  fixture follows the same rule.
- Implemented and unit-tested on 2026-11-25: v1/v2 parsing, the engine/network
  allow-list, generation 2, the runtime-only network fragment, the profile
  refusals and the env-file metadata checks. The generated Compose file was
  validated with the real Compose CLI with the env file absent (`required:
  false`).
- Disposable lab passed on 2026-11-25
  (`bun run test:managed-sites-e2e:wsl`): MariaDB 11 on its own external
  network, a PHP 8.3 runtime built with `pdo_mysql`, a record written before the
  first deploy, still readable after deploying the next commit and after
  rolling back to the first. Site A's account was denied reading and writing
  site B's table; site B's own account read it. The generated Compose file also
  validated with the real Compose CLI with the env file absent (`required:
  false`). The real-host checklist applies separately, because the lab cannot
  prove host networking or DNS.
- Rollback: remove the block, restore the previous manifest version if needed
  and regenerate. The site leaves the external network; the database and its
  data are untouched.

## Out of scope

Provisioning, SQL execution, dumps and restores, migrations, workers, multiple
databases per site, credential UI or rotation, connection pooling, database
health checks, cross-site sharing, backup credentials, a panel-side SQL client
and engine-specific backup adapters.
