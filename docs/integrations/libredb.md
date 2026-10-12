# External database explorer — LibreDB Studio example

Compose Panel can link a stack to an external database explorer through a
declarative `x-compose-panel.database` extension. The panel only builds the link:
it never contacts the explorer, reads no credential and opens no database
([ADR 0027](../adr/0027-external-database-explorer-links.md)).

This page shows one concrete deployment with
[LibreDB Studio](https://github.com/libredb/libredb-studio). The same pattern
works for any explorer that preselects a server or a database through URL
parameters (Adminer, pgAdmin…). The panel configuration is the same; only the
`query` parameters change.

> The panel integration and the explorer deployment are independent. Compose
> Panel works normally — no link, no error — when the explorer is absent,
> stopped or unreachable. Deploy and test the explorer on its own.

## 1. Access model

The recommended model reuses the panel's own access pattern:

```text
browser ── VPN + HTTPS ──> Caddy (host, IP allow-list) ──> 127.0.0.1:3001
                                                             │
                                                             └─ LibreDB (Docker)
                                                                  │ private Docker network
                                                                  └─ PostgreSQL :5432
```

Three successive protections:

1. **Private network access** — a reverse proxy with an IP allow-list (VPN,
   Tailscale, or an SSH tunnel for occasional use).
2. **Explorer authentication** — its own login; a VPN must not be enough to open
   a database session.
3. **PostgreSQL permissions** — the effective protection against unwanted reads
   or writes.

PostgreSQL is never reachable from the browser: only the explorer talks to it,
over a Docker network. Do not publish port 5432.

## 2. Deploy LibreDB Studio

Create a dedicated stack, for example `/opt/stacks/libredb/`, with a protected
`.env` (`chmod 600`), persistent storage and a seed-connection file.

`compose.yaml`:

```yaml
services:
  studio:
    image: ghcr.io/libredb/libredb-studio:<verified-version>
    restart: unless-stopped

    ports:
      - "127.0.0.1:3001:3000"

    environment:
      ADMIN_EMAIL: ${ADMIN_EMAIL}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
      AUTH_BOOTSTRAP: "off"
      STORAGE_PROVIDER: sqlite
      SEED_CONFIG_PATH: /app/config/seed-connections.yaml
      SHOP_STAGING_RO_PASSWORD: ${SHOP_STAGING_RO_PASSWORD}

    volumes:
      - ./seed-connections.yaml:/app/config/seed-connections.yaml:ro
      - libredb-data:/app/data

    networks:
      - staging

networks:
  staging:
    external: true
    name: shop-staging_default

volumes:
  libredb-data:
```

- The port is bound to `127.0.0.1` only: reachable from the host, not directly
  from a remote client.
- `AUTH_BOOTSTRAP=off`, `STORAGE_PROVIDER=sqlite` and `SEED_CONFIG_PATH` are
  documented LibreDB settings. Pin the image to a version you have verified;
  re-check the upstream documentation when you upgrade.
- Secrets stay in the stack's `.env` (or the deployment's secret store), never in
  a committed file.

`seed-connections.yaml` describes the connections. Passwords come from
environment variables, so the file can be versioned without secrets:

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

`managed: true` keeps the connection definition out of the web interface and
resolves the credentials server-side, so they are not sent to the browser. It
does **not** make the SQL read-only: that is enforced by PostgreSQL, below.

## 3. Publish it privately behind Caddy

Add a private subdomain with the same access restriction you already use for the
panel. `remote_ip` filters the peer that connects directly to Caddy:

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

## 4. Restrict PostgreSQL

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

## 5. Network isolation

For a first validation on staging, attaching the explorer to the application's
Compose network (`shop-staging_default`) is acceptable. It gives the explorer
access to every service on that network, not only PostgreSQL.

For production, prefer a dedicated administration network shared by the database
and the explorer only:

```text
shop-staging_default        shop-staging-db-admin
    ├── app                      ├── db
    └── db                       └── libredb
```

Attach `db` to both networks and `libredb` only to the administration network, so
the explorer has no route to the application's other services.

Because several stacks use a service named `db`, give each a distinct network
alias, for example `shop-staging-db`, to avoid DNS ambiguity.

### A note on `ALLOW_CUSTOM_CONNECTIONS`

You may find the setting `ALLOW_CUSTOM_CONNECTIONS=false` mentioned in some
discussions. It does **not** appear in the documented Docker deployment or the
current README. Do not rely on it as a security guarantee without verifying it
on the exact version you run. Treat the database permissions (section 4) and the
network isolation (this section) as the effective controls, independent of the
explorer's interface options.

## 6. Connect Compose Panel

Configure the base URL of the explorer, once, in the panel's environment:

```dotenv
COMPOSE_PANEL_DATABASE_EXPLORER_URL=https://db.example.com
```

Then declare the link in each stack's `compose.yaml`:

```yaml
x-compose-panel:
  database:
    label: LibreDB
    query:
      connection: seed:shop-staging
```

Compose Panel builds `https://db.example.com/?connection=seed%3Ashop-staging`
and shows an **Explore the database** link on the stack page. After
authentication, LibreDB selects the preconfigured connection. The link carries
only the public connection id — never a password.

The `label` and `query` fields are explorer-agnostic. Values are strings or
booleans; quote numeric values (`port: '5432'`), since YAML would otherwise
rewrite their form. For example, with Adminer:

```yaml
x-compose-panel:
  database:
    label: Adminer
    query:
      pgsql: shop-staging-db
      db: shop
      username: libredb_ro
```

These parameter names are illustrative — Adminer commonly also needs
`username=`. Verify them against the documentation of the exact version you
deploy; the panel passes them through without interpreting them.

## 7. Bring-up order

1. Deploy `/opt/stacks/libredb/` with its protected `.env`, persistent storage
   and connection file.
2. Publish a private subdomain in Caddy with the same access restriction as the
   panel.
3. Create a read-only PostgreSQL account on staging.
4. Attach the explorer to a network that reaches that database, without
   publishing 5432.
5. Verify the explorer sign-in, the PostgreSQL permissions, and that access is
   refused outside the VPN.
6. Add `COMPOSE_PANEL_DATABASE_EXPLORER_URL` and the `x-compose-panel.database`
   extension.
7. Extend to the other environments after the read grants are validated.

Final path:

```text
Compose Panel → Explore the database → Caddy (private) → LibreDB login
    → selected PostgreSQL connection → PostgreSQL permissions
```

## 8. What the panel does not do

- It does not create database users, connections or secrets.
- It does not read any credential or query result.
- It does not configure Docker networks or the explorer.
- It does not verify that a declared connection exists — that is the explorer's
  responsibility.

The panel provides the entry point; the explorer manages connections; PostgreSQL
applies the permissions.
