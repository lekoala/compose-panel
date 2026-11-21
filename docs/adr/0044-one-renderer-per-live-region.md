# ADR 0044 — One renderer per live region

Status: accepted (2026-11-21).

## Context

The Server page is rendered twice: Bun builds the tables for the first load and
`public/app.js` rebuilds the same rows in DOM from a JSON payload when Live is
enabled. The two implementations have already drifted (an unknown memory value
loses its `muted` class after the first refresh, and so does an unknown PID), so
a new column has to be added twice and checked twice.

The next screens (Managed Sites creation and preview) would repeat the same
shape. The tools to remove the duplication are the ones already in the
repository: a view function that returns escaped HTML. A template engine
(`hono/html`) is not justified here: its escaped-string type is lost by the
`+` concatenation used throughout `src/html.ts`, so a migration would be a
whole-module rewrite with a second escaping model in the meantime. h3 brings
routing only (and two transitive packages) and does not address rendering.

## Decision

1. **A dynamic region has exactly one renderer.** The first load and every
   refresh call the same view function in `src/features/<feature>/views.ts`.
   The refresh returns the escaped rows for the zones it owns; the browser
   assigns them to the existing container element with `innerHTML`. There is no
   second DOM builder in `public/app.js`.

2. **A collection failure never erases displayed data.** A null zone means
   "not obtained" and the browser keeps the last successful rows. Counters
   (`runningContainers`, attention and exited counts) are separate so an
   unavailable table still lets the page report what it could read. This
   preserves the honest-null rule of ADR 0015 in the browser as well.

3. **A fragment endpoint answers 401, never a login redirect.** Once the
   session ends, a redirect would put the sign-in page inside a statistics
   table. `/server/stats` follows the event-stream rule and returns
   `401 Unauthorized`; the browser stops polling.

4. **Presentation-only inputs stay bounded.** The Live refresh deliberately
   does not call `docker info`, so the browser echoes the memory total the page
   already displays (`?mem=`), validated as a bounded integer, to keep the
   decorative stack bars on the same scale. It is never used for a decision.

5. **The web layer is split by feature, not by framework.** `src/app.ts` keeps
   the single `fetch` dispatcher and its guard order (Host, static assets,
   session, routes). Feature views move to `src/features/<feature>/views.ts` as
   they are touched; shared formatting moves to `src/web/`. A router (Hono, h3
   or `Bun.serve({ routes })`) is revisited only if declaring routes or applying
   the right guard to each becomes a recurring difficulty. If a third screen
   repeats "fetch a fragment, replace a region", compare htmx and a small
   browser helper before a framework.

6. **JavaScript is decided per flow.** Existing navigation and operations keep
   native links and forms; a form post is the shortest complete implementation
   of Deploy and must stay usable without JavaScript. A new authoring flow may
   require JavaScript when maintaining two interfaces would be worse for the
   user and the code, but only with a stated reason, a visible note when the
   flow depends on it, and an update to `AGENTS.md` when the first such flow
   ships. Live updates remain progressive enhancement: the page works without
   them.

7. **Browser modules are a separate change.** Splitting `public/app.js` into ES
   modules is not required by this decision and carries its own test-harness
   change.

## Consequences

- Adding a column to the Server tables is one edit in one function, covered by
  a parity test that the first render and the Live payload agree.
- `innerHTML` of a same-origin, server-escaped fragment becomes a trust
  boundary that must be tested for hostile container, stack and issue names.
  The CSP is unchanged; Trusted Types are not enabled.
- `src/app.ts` and `src/html.ts` keep shrinking per feature, with no dependency
  added and no router migration.
- The Server pilot does not test the "JavaScript required" exception; that
  decision applies to a future authoring flow and stays independent of this
  renderer choice.

## Verification and rollback

Tests cover the shared rows (parity), escaping, the null/empty distinction, the
401 without a session, and the browser keeping the last rows on a partial
failure while counters update. Rollback restores the JSON payload and the
browser DOM builder; no data, route or Docker resource is affected.
