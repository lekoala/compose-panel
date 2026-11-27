# ADR 0059 - Database explorer link in the managed-site manifest

Status: Accepted (0.7.0).

## Context

[ADR 0027](0027-external-database-explorer-links.md) lets a stack declare an
`x-compose-panel.database` extension in its own Compose file, which the panel
turns into an external explorer link. That works for an opt-in stack, whose
Compose file the operator owns.

A generated managed site is different. Its `compose.yaml` is produced from
`compose-panel-site.json` and compared byte-for-byte for drift, so the operator
cannot add the extension without breaking the generated-file contract. A site
that attaches an existing database ([ADR 0048](0048-existing-database-attachment.md))
therefore has no way to offer the same "Explore the database" entry point.

The link is presentation only. It is not part of the Compose deployment, it
changes no container and no network, and generating it into the Compose file
would force a new generation and a regeneration of every existing site.

## Decision

### The manifest carries the link, the panel reads it

Version 4 of the site manifest adds one optional top-level block:

```json
"databaseExplorer": {
  "label": "LibreDB",
  "query": {
    "connection": "seed:acme-shop"
  }
}
```

It uses the same model, bounds and validation as the Compose extension. The
shared parser (`parseExplorerDeclaration` in `src/database.ts`) is called by both
sources, so one source cannot accept what the other refuses.

- The block belongs to `owner: "managed"`. An opt-in stack already declares the
  link in its own Compose file; accepting a second source would create two
  conflicting declarations for the same card.
- It requires manifest version 4 and later. Version 1, 2 and 3 stay valid and
  unchanged, and a site opts in by setting `version: 4` (keeping any database,
  backup or CI blocks, whose checks now accept a later version).
- The panel reads `databaseExplorer` from the parsed manifest when it renders a
  managed site. It does not emit the block, or an `x-compose-panel` extension,
  into `compose.yaml`. The generator version therefore stays `1` or `2`: no
  existing site needs regeneration, and drift is unchanged.
- The manifest serializer preserves the block, so **Regenerate generated files**
  cannot silently drop it.
- No block means no link, exactly as before. An invalid block refuses the
  manifest through the normal strict parse, and the stack page reports the
  reason without a `500`.

### Same guarantees as ADR 0027

The panel still builds a URL from trusted configuration and a bounded scalar
query map. It never contacts the explorer, reads no credential and opens no
database. The parameters are public by construction - a connection id, a host, a
database name - and a secret must never be placed in them. Without
`COMPOSE_PANEL_DATABASE_EXPLORER_URL`, no link is rendered.

## Consequences

- A managed site with an attached database gets the same "Explore the database"
  card as an ordinary stack, with no generated-file change.
- One new manifest version and one new optional block; no new generation, no
  migration and no Docker capability.
- The version checks for `backup` and `ci` become "version N or later" so a
  version 4 manifest keeps them. This is a correctness fix: the previous strict
  equality would have refused them on any later version.

## Alternatives considered

- **Generate `x-compose-panel.database` into the site's Compose file**: rejected.
  It changes the artifact shape, forces a new generation and a regeneration of
  existing sites, and puts a UI-only declaration into a deployment file.
- **Read the link from the site's private `database.env`**: rejected. The panel
  must never read, parse or render a credential file, and a connection name is
  not a credential.
- **A per-site absolute explorer URL**: still deferred, as in ADR 0027. One
  global base URL and bounded query parameters cover the need.

## Verification

`tests/managed-site.test.ts` covers the accepted version 4 block, the refusal on
version 3 and on an opt-in stack, an unknown field, a non-object, and the shared
label/query bounds (including a refused bare number). It also covers a version 4
manifest that keeps `backup` and `ci`. `tests/app.test.ts` covers the rendered
card from a manifest and asserts that the generated Compose file carries no
extension.
