# ADR 0058 - Curated Compose recipes

Status: Accepted (0.7.0).

## Context

Compose Panel is a Compose-first hosting panel: it manages stacks the operator
already owns, and the managed-site pilot generates one fixed PHP layout. The
documented way to add a complementary hosting service - a database explorer, a
backup target - is to paste a reviewed `compose.yaml` into the **New stack**
form after reading a long deployment guide.

[product.md](../product.md) listed "generated templates/catalogues" as not
planned, and [ADR 0027](0027-external-database-explorer-links.md) rejected an
integration registry as speculative. Both decisions were about a *catalogue*: a
distant list of applications with their own lifecycle and upgrade logic. They
were not a judgement on shipping a few reviewed starting points for a form that
already exists.

The concrete need is recorded: linking a stack to an external database explorer
works, but installing that explorer itself takes seven documented manual steps.
A hosting panel that offers a database link should make the other end of that
link easy to create.

## Decision

### A recipe is a prefill, not a product type

A recipe is a reviewed constant in `src/recipes.ts`: an id, a label, a summary,
a default stack name, a `compose.yaml`, an `.env` and a note. **New stack**
lists the recipes; `/new-stack?recipe=<id>` pre-fills the existing textareas and
the stack name. Nothing else changes:

- the form posts the submitted text to the existing creation path
  (`createStack`), with the same name validation, Compose validation, project
  collision check, atomic publication and audit record;
- nothing is fetched, pulled, started or written by opening a recipe;
- the panel generates no secret and allocates no port: the operator fills the
  secrets and chooses the host port, and the recipe stays visible and editable;
- after creation the stack is an ordinary stack. The panel applies no special
  lifecycle, no upgrade automation and no uninstall flow to it.

The recipe text is part of the source, reviewed like documentation, and pinned
to one release. There is no registry, no remote recipe endpoint, no manifest
format and no recipe-specific parser.

### Scope and non-goals

A small curated set is allowed. Each entry is a code change that states why the
recipe exists and which host setup it assumes. Recipes are infrastructure
services an operator complements a hosting setup with, not an application
catalogue:

- no general application catalogue, app store or one-click provisioning;
- no secret generation, credential display or password rotation;
- no automatic port allocation, domain attachment or Caddy rule;
- no image upgrade automation: a recipe is a pinned starting point, and its
  documented upgrade procedure is to edit the file;
- no remote manifests or user-supplied recipe sources.

This narrows the [product.md](../product.md) non-goal: "generated
templates/catalogues" stays refused as a catalogue, while reviewed recipes for
complementary hosting services are admitted.

### The first recipe

LibreDB Studio 1.3.0, pinned by digest, loopback-only, SQLite storage and strict
auth bootstrap. The operator sets `ADMIN_PASSWORD` and `JWT_SECRET`; the recipe
uses `${VAR:?message}` so the existing Compose validation refuses creation while
a required value is empty. The companion guide is
[integrations/libredb.md](../integrations/libredb.md).

## Consequences

- The operator starts from a reviewed file instead of a seven-step copy/paste,
  and still owns every line afterwards.
- The panel gains no Docker capability: the recipe uses the creation path that
  already exists. It gains one page state (`?recipe=`) and one constant module.
- A recipe can rot like documentation. It is tested for a unique id, valid YAML,
  a digest-pinned image and required secret placeholders; the guide carries the
  version, the digest and the upgrade procedure.
- A recipe must not become a back door to a catalogue: adding a second entry is
  a deliberate product decision, not a configuration value.

## Alternatives considered

- **A full installer** (the panel creates the stack, generates the JWT secret,
  picks a loopback port and offers a Caddy domain): rejected for 0.7. It adds
  secret generation, port allocation and a domain flow to the panel, and it
  makes the panel responsible for a service it does not manage.
- **Documentation only**: rejected. The form already exists; a reviewed prefill
  removes the copy/paste without adding a second mechanism.
- **A remote recipe registry or marketplace**: rejected. It introduces trust,
  versioning, caching and an update surface for no recorded need.
- **A recipe-specific lifecycle** (install, upgrade, uninstall): rejected. The
  stack becomes ordinary at creation; Docker Compose remains the lifecycle.

## Verification

`tests/recipes.test.ts` checks unique ids, lookup behavior, valid YAML, the
digest-pinned image, the loopback port, `stop_grace_period`, SQLite storage and
the required `${...:?}` placeholders. `tests/app.test.ts` checks that a recipe
pre-fills the existing form, that an unknown id is ignored, and that the page
still renders normally. `bun run typecheck` and `bun run test` are the gates.
