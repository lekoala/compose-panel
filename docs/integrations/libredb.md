# External database explorer - LibreDB Studio example

Compose Panel can link a stack to an external database explorer through a
declarative declaration. The panel only builds the link: it never contacts the
explorer, reads no credential and opens no database
([ADR 0027](../adr/0027-external-database-explorer-links.md)).

This page shows one concrete deployment with
[LibreDB Studio](https://github.com/libredb/libredb-studio). The same pattern
works for any explorer that preselects a server or a database through URL
parameters (Adminer, pgAdmin.). The panel configuration is the same; only the
`query` parameters change.

> The panel integration and the explorer deployment are independent. Compose
> Panel works normally - no link, no error - when the explorer is absent,
> stopped or unreachable. Deploy and test the explorer on its own.

## 1. Access model

The recommended model reuses the panel's own access pattern:

```text
browser -> VPN + HTTPS -> Caddy (host, IP allow-list) -> 127.0.0.1:3001
                                                            |
                                                            +-> LibreDB (Docker)
                                                                  | private Docker network
                                                                  +-> PostgreSQL :5432
```

Three successive protections:

1. **Private network access** - a reverse proxy with an IP allow-list (VPN,
   Tailscale, or an SSH tunnel for occasional use).
2. **Explorer authentication** - its own login; a VPN must not be enough to open
   a database session.
3. **Database permissions** - the effective protection against unwanted reads
   or writes.

The database is never reachable from the browser: only the explorer talks to it,
over a Docker network. Do not publish the database port.

## 2. Create the stack

### From the panel (recommended)

**New stack → LibreDB Studio** pre-fills the existing form with a reviewed
`compose.yaml` and `.env` ([ADR 0058](../adr/0058-curated-compose-recipes.md)).
The recipe is a starting point, not an installer: nothing is pulled or started
until you create the stack and then use **Pull** and **Up**.

1. Set `ADMIN_PASSWORD` and `JWT_SECRET` in the pre-filled `.env`. Both are
   required: the panel refuses the stack while either is empty
   (`${VAR:?message}` in the Compose file). `JWT_SECRET` must be at least 32
   characters; generate one with `openssl rand -base64 32`.
2. Keep `127.0.0.1:3001:3000`, or change the host port if 3001 is taken.
3. Create the stack, then **Pull** and **Up**.
4. Sign in at `http://127.0.0.1:3001` through an SSH tunnel, or publish it
   privately as described in section 4.

The recipe pins LibreDB Studio 1.3.0 by digest
(`ghcr.io/libredb/libredb-studio:1.3.0@sha256:3521f28f…`). A digest-pinned image
is reported as **not tracked** by the update check: that is expected, because no
tag is followed. To upgrade, replace both the tag and the digest with a version
you have verified, then **Pull + up**. A fixed release tag alone would not detect
a new version either, and a rewritten tag would silently change the image; the
digest closes that gap.

### By hand

Create a dedicated stack, for example `/opt/stacks/libredb/`, with a protected
`.env` (`chmod 600`) and persistent storage.

`compose.yaml`:

```yaml
services:
  studio:
    image: ghcr.io/libredb/libredb-studio:1.3.0@sha256:3521f28fc2732a040715015669dfb475a1f2bc60b31025cb58ef472379ca74c7
    restart: unless-stopped
    # Studio's shutdown takes up to 25 s; Compose defaults to 10 s.
    stop_grace_period: 30s

    ports:
      - "127.0.0.1:3001:3000"

    environment:
      ADMIN_EMAIL: ${ADMIN_EMAIL:-admin@libredb.org}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:?set a strong explorer administrator password}
      JWT_SECRET: ${JWT_SECRET:?set a random secret of at least 32 characters}
      AUTH_BOOTSTRAP: "off"
      STORAGE_PROVIDER: sqlite
      STORAGE_SQLITE_PATH: /app/data/libredb-storage.db

    volumes:
      - libredb-data:/app/data

volumes:
  libredb-data:
```

`.env` (mode `0600`, never committed):

```dotenv
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=
JWT_SECRET=
```

- The port is bound to `127.0.0.1` only: reachable from the host, not directly
  from a remote client.
- `AUTH_BOOTSTRAP=off` refuses to start without the two secrets. Without it,
  LibreDB generates them on first start and prints the administrator password to
  the container log - a credential in the panel's log viewer. Set them yourself.
- `STORAGE_PROVIDER=sqlite` keeps connections and saved queries on the volume,
  with no second database.
- Single-quote a value that contains `$`: Compose expands unquoted `env_file`
  values.

## 3. Choose how connections are managed

LibreDB Studio can accept connections created in its interface, or only the ones
an operator pre-declares. Pick one deliberately.

### Interactive (the recipe default)

Custom connections are allowed (LibreDB's default). Each signed-in account can
add a connection to any host and port the container's networks reach. Acceptable
when the explorer is reachable only by administrators, through a private path.

### Restricted with seed connections

Disable custom connections and pre-declare the allowed ones. Add these keys to
the `studio` service of the Compose file above:

```yaml
services:
  studio:
    environment:
      ALLOW_CUSTOM_CONNECTIONS: "false"
      SEED_CONFIG_PATH: /app/config/seed-connections.yaml
    volumes:
      - ./seed-connections.yaml:/app/config/seed-connections.yaml:ro
```

`ALLOW_CUSTOM_CONNECTIONS=false` is documented and enforced server-side by
LibreDB 1.3.0; an unrecognised value also fails closed. **Never set it without a
seed file**: the instance becomes unusable, since no connection can be created
or listed.

`seed-connections.yaml` describes the connections. Create it on the host, next
to `compose.yaml` (the panel's editor only manages the Compose file and `.env`).
Passwords come from environment variables, so the file can be versioned without
secrets:

```yaml
version: "1"

defaults:
  managed: true

connections:
  - id: shop-staging
    name: Shop Staging
    type: postgres
    host: shop-staging-db
    port: 5432
    database: shop
    user: libredb_ro
    password: "${SHOP_STAGING_RO_PASSWORD}"
    roles: ["admin"]
```

Add `SHOP_STAGING_RO_PASSWORD` to the stack's `.env`. `managed: true` keeps the
definition out of the web interface and resolves the credential server-side. It
does **not** make SQL read-only: the database grants do, below.

## 4. Publish it privately

**Do not attach this stack through the panel's Domains card.** That helper
writes a plain `reverse_proxy 127.0.0.1:<port>` with no access rule
([ADR 0030](../adr/0030-optional-caddy-sites.md)): it is meant for public sites,
not for an administration tool. Add a private site to the host `Caddyfile`
instead, with the same restriction you already use for the panel. `remote_ip`
filters the peer that connects directly to Caddy:

```caddyfile
db.example.com {
    @blocked not remote_ip <VPN_IP_OR_CIDR>
    respond @blocked 403

    reverse_proxy 127.0.0.1:3001
}
```

Keep the explorer's own authentication in front of any database session. An SSH
tunnel is a useful fallback for occasional access, without publishing anything:

```bash
ssh -N -L 3001:127.0.0.1:3001 user@host
# then open http://localhost:3001
```

Check that the explorer's session cookies work from the tunnel's origin.
`AUTH_COOKIE_SECURE` defaults to secure cookies; `localhost` counts as a secure
context, so the tunnel works without changing it.

## 5. Restrict the database account

Create a dedicated login per database, one password per environment, and grant
only what a diagnostic needs:

- Connect to the database.
- `SELECT` on the specific tables or, preferably, on dedicated diagnostic views.

For production data, expose views rather than the full tables. Message logs and
application logs must not contain query results or secrets.

A starting point (adjust to your schema):

```sql
-- As a superuser, on the target database:
CREATE ROLE libredb_ro LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE shop TO libredb_ro;
GRANT USAGE ON SCHEMA public TO libredb_ro;
-- Either restrict to named diagnostic views, or grant SELECT broadly if the
-- database holds no sensitive data:
GRANT SELECT ON ALL TABLES IN SCHEMA public TO libredb_ro;
```

Do not reuse the application's full credentials, especially in production.

## 6. Network isolation

Attaching the explorer to the application's Compose network
(`shop-staging_default`) is acceptable for a first validation. It gives the
explorer access to every service on that network, not only the database.

For production, prefer a dedicated administration network shared by the database
and the explorer only:

```text
shop-staging_default        shop-staging-db-admin
    +-- app                     +-- db
    +-- db                      +-- libredb
```

Attach `db` to both networks and `libredb` only to the administration network, so
the explorer has no route to the application's other services.

Because several stacks use a service named `db`, give each a distinct network
alias, for example `shop-staging-db`, to avoid DNS ambiguity.

## 7. Connect Compose Panel

Configure the base URL of the explorer, once, in the panel's environment:

```dotenv
COMPOSE_PANEL_DATABASE_EXPLORER_URL=https://db.example.com
```

The value is an origin: no path, query, fragment or credentials, and `https`
outside `COMPOSE_PANEL_DEV` ([ADR 0027](../adr/0027-external-database-explorer-links.md)).

### Ordinary stacks

Declare the link in the stack's own `compose.yaml`:

```yaml
x-compose-panel:
  database:
    label: LibreDB
    query:
      connection: seed:shop-staging
```

### Managed sites

A generated site owns its `compose.yaml`, so the link lives in
`compose-panel-site.json`, version 4 ([ADR 0059](../adr/0059-managed-site-database-explorer-link.md)):

```json
"version": 4,
"databaseExplorer": {
  "label": "LibreDB",
  "query": {
    "connection": "seed:acme-shop"
  }
}
```

The block is UI-only: the panel reads it from the manifest and never generates
it into the Compose file, so the generated files and their drift check are
unchanged. It belongs to `owner: "managed"`; an opt-in stack uses the Compose
extension above. Version 4 keeps the optional `database`, `backup`, `ci` and
`build` blocks.

Both sources are validated by the same parser. Values are strings or booleans;
a bare number is refused in both - in the Compose file, YAML would also rewrite
its form - so quote it (`port: '5432'` in YAML, `"5432"` in JSON). Nothing is
generated, stored or logged.

For LibreDB Studio the parameter is `connection=seed:<id>`. The panel builds
`https://db.example.com/?connection=seed%3Ashop-staging`; the editor reads the
parameter, opens the connection and removes it from the address bar. The
`/n=seed%3A<id>` link form is equivalent. After authentication, the connection
is selected. The link carries only the public connection id - never a password.

With Adminer, the parameters differ; the contract is explorer-agnostic. For
example:

```yaml
x-compose-panel:
  database:
    label: Adminer
    query:
      pgsql: shop-staging-db
      db: shop
      username: libredb_ro
```

These parameter names are illustrative - Adminer commonly also needs
`username=`. Verify them against the documentation of the exact version you
deploy; the panel passes them through without interpreting them.

## 8. Bring-up order

1. Create the LibreDB stack from the recipe (or by hand), set its secrets and
   start it. Verify the sign-in over the loopback port.
2. Publish a private subdomain in Caddy with the same access restriction as the
   panel - not through the stack's Domains card.
3. Create a read-only database account per concrete database.
4. Attach the explorer to a network that reaches those databases, without
   publishing their ports.
5. Verify the explorer sign-in, the database permissions, and that access is
   refused outside the VPN.
6. Add `COMPOSE_PANEL_DATABASE_EXPLORER_URL`, then the link declaration on the
   stacks or managed sites.
7. Extend to the other environments after the read grants are validated.

Final path:

```text
Compose Panel -> Explore the database -> Caddy (private) -> LibreDB login
    -> selected connection -> database permissions
```

## 9. What the panel does not do

- It does not create database users, connections, secrets or seed files.
- It does not read any credential, `database.env` or query result.
- It does not configure Docker networks or the explorer.
- It does not generate secrets, allocate ports or attach a domain for a recipe.
- It does not verify that a declared connection exists - that is the explorer's
  responsibility.
- It does not manage the explorer's upgrade: edit the pinned tag and digest and
  pull again.

The panel provides the entry point and a reviewed starting file; the explorer
manages connections; the database applies the permissions.
