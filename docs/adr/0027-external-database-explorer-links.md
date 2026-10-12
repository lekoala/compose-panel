# ADR 0027 — External database explorer links

Status: Accepted

## Context

Administrators routinely need to inspect a stack's data: list tables, read a few
rows, run a diagnostic query. Today that happens outside the panel, by hand,
through `docker compose exec <service> psql` or a separately deployed web tool.

Building a SQL client inside the panel is out of scope and would be
security-sensitive: it would need database credentials, a query surface and its
own authorization model. A dedicated explorer (LibreDB Studio, Adminer, pgAdmin,
and others) already handles connections, authentication and query execution.

The panel's place is narrower: it knows which stacks exist and can offer a
convenient, declarative entry point to such an external tool, without becoming
responsible for secrets or database access.

## Decision

### The panel builds a link, nothing more

Compose Panel never contacts the explorer and never reads a credential. It
builds a URL from administrator configuration and a stack-declared extension,
then serves it as a plain external link. There is no server-side request to the
explorer, no health check and no verification that a declared connection exists.
That responsibility belongs to the explorer.

The integration is deliberately **agnostic of the software**. The contract names
no product: it carries a base URL and a set of query parameters.

### Global base URL

A single optional setting, `COMPOSE_PANEL_DATABASE_EXPLORER_URL`, holds the base
URL of the explorer, for example `https://db.example.com`. It is normalized to
an origin and validated at startup like the other access settings: http(s) only,
https outside `COMPOSE_PANEL_DEV`, and no credentials, path, query or fragment.
V1 targets an explorer served at the root of its domain (no `BASE_PATH`); a
custom base path would need a dedicated deployment and is refused rather than
silently ignored.

An empty value disables the feature: no stack shows a database link. An invalid
value is refused at startup, because it is administrator configuration, not
stack metadata.

### Stack extension

A stack declares its link in the canonical Compose file, through a Compose
extension field that Compose ignores at deploy time:

```yaml
x-compose-panel:
  database:
    label: LibreDB
    query:
      connection: seed:shop-staging
```

- `label` is optional display text naming the explorer software.
- `query` is a mapping of scalar parameters. Only **strings and booleans** are
  accepted; a bare numeric value is refused, because the YAML parser turns
  `0123`, `0x1F`, `1e3` or a very large integer into a number whose textual form
  differs from what was written, which could silently change the target. Quote
  numeric values (`port: '5432'`). Nested mappings, lists and null values are
  refused. Keys and values reject control characters and are length-bounded, and
  the number of parameters is capped, so a declaration cannot inflate the link.
- Parameter order is not guaranteed (JavaScript orders integer-like keys first);
  the panel makes no promise about it and the query string is order-independent.
- The panel reads the field from the raw Compose file with Bun's YAML parser and
  never rewrites the file. Multi-file Compose stays rejected
  ([ADR 0004](0004-single-file-editing.md)).

The parameters are whatever the explorer's own URL format expects. For LibreDB
Studio it is `connection=seed:<id>`; for Adminer it is `pgsql=<host>&db=<name>`
(and often `username=`) — these are illustrative, verify them against the
documentation of the version you deploy. The panel does not interpret them.

### Link building

The link is built with `new URL()` and `URLSearchParams`: the base is the
configured origin and each declared parameter is added as a query value. The
base URL is already validated at startup, so `buildExplorerUrl` does no repeated
checks; a single defensive check runs at render (`isExplorerHref`). The
parameters are public by construction — a connection identifier, a host, a
database name — and a secret must never be placed in them. Nothing about the
link is stored or logged.

### Failure model

- Invalid global URL: refused at startup, like the other administrator settings.
- Invalid stack extension: reported as a warning on the stack page; the stack
  stays fully manageable.
- No global URL or no extension: no link, no warning.

### Independence

The panel works exactly as before when the explorer is absent, stopped or
unreachable. The link is inert until an administrator clicks it, and even then
the target is a separate system with its own authentication. The logic lives in
a pure module, `src/database.ts` (parsing, validation, URL building): no Docker,
no filesystem, no network.

## Consequences

- `architecture.md`, `security.md`, `product.md` and `roadmap.md` carry the
  feature; `docs/integrations/libredb.md` documents one concrete deployment as an
  example.
- No new dependency: Bun's YAML parser and the standard `URL` API are enough.
- No new Docker capability and no privileged surface: the panel gains no ability
  to run a command, read a container or reach a database.
- Changing the explorer software is a configuration change, not a code change.

## Alternatives considered

- **A LibreDB-specific contract** (`explorer: libredb`, `connection: <id>`):
  rejected. It would write one product into the panel's public contract for no
  functional gain, since the only thing the panel does is build a URL.
- **A per-stack absolute URL override**: deferred. It would help when several
  explorers coexist, but it is not required for V1 and it widens the field an
  administrator can put in a stack file.
- **A plugin or integration registry**: rejected as speculative. One base URL
  and a scalar query map cover the declared need.
- **An embedded SQL client or an iframe of the explorer**: rejected. It would
  pull database credentials and query execution into the panel, which is exactly
  what this ADR avoids. The explorer stays a separate system behind its own
  access control.

## Verification

`tests/database.test.ts` covers the extension parsing (absent block, a label
without a query and vice versa, a refused bare number and an accepted boolean,
a non-mapping block, a non-scalar, empty, over-long or control-character value,
too many parameters, invalid YAML), the link building (the LibreDB deep link, a
multi-parameter Adminer link, an empty query) and the render-time check
`isExplorerHref` (http(s), a long link built from bounded parameters, a refused
non-http scheme, credentials and an over-long value).
`tests/config.test.ts` covers the global URL parsing (default null, origin
normalization, refused http outside development, refused credentials, path,
query and fragment). `tests/html.test.ts` covers the card rendering, the
escaping of the label and query values, the absence of a link for an invalid
declaration and the refusal of a non-http target. `tests/app.test.ts` covers the
stack page: the link appears only with both the extension and the global URL, an
invalid declaration is a warning and never a `500`. `bun run test` and
`bun run typecheck` are the quality gates; no Docker test is needed.

## Out of scope

Creating database users, connections or secrets; reading any credential;
configuring Docker networks or the explorer itself; a per-stack absolute URL
override; a registry of integrations; embedding the explorer; any panel-side
database query.
