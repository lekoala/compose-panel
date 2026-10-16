# ADR 0030 — Optional Caddy site management

Status: Accepted

## Context

Some stacks serve HTTP on the host loopback (for example a `web` service
listening on `127.0.0.1:8080`). Reaching them from outside currently requires
editing the reverse-proxy configuration by hand over SSH: adding a site block
such as `app.example.com` → `reverse_proxy 127.0.0.1:8080`, then reloading the
proxy. The panel already covers the rest of the flow — create the stack,
configure it, start it, read its logs — but not this last routing step.

The host already runs Caddy with its own `Caddyfile`. Some stacks are deployed
by an external continuous-delivery system whose routing is owned elsewhere and
must stay untouched.

## Decision

### The panel manages only the sites it created

Compose Panel never edits the main `Caddyfile` and never rewrites an existing
site. It owns exactly one directory of per-domain files:

```text
/etc/caddy/compose-panel.d/
  app.example.com.caddy
  shop.example.com.caddy
```

The main `Caddyfile` imports that directory once, as a host operation outside
the panel:

```caddyfile
import /etc/caddy/compose-panel.d/*.caddy
```

Each file carries its own ownership metadata in a strict header, followed by
the single canonical site block:

```caddyfile
# compose-panel:managed v1
# compose-panel:stack web
# compose-panel:service web

app.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

V1 scope is deliberately narrow: one public domain → one local HTTP upstream.
No path rules, no wildcards, no Caddy-level authentication options, no
`Caddyfile` editor. Only TCP ports published on `127.0.0.1` are eligible —
exactly what the managed file dials — so an IPv6-only or UDP publication can
never pass the check while producing a broken proxy.

### Host helper behind a Unix socket, no sudo from the container

The panel runs in a container, so a host `sudoers` rule cannot apply to it.
 privileged work happens in a small host helper, reachable through a Unix
socket mounted into the panel container and activated on demand via systemd:

- Closed protocol: `attach`, `detach`, `list`/`status`. No free command, no
  shell, no user-supplied path: the managed directory and the main `Caddyfile`
  are fixed in the helper's own host-side configuration. The panel sends a
  structured request (`domain`, `stack`, `service`, upstream port); the helper
  renders the file itself and is authoritative for writes.
- The helper runs as the `caddy` user whenever file permissions and
  `caddy reload` allow it, rather than as `root` unconditionally.
- The panel → helper channel uses bounded request/response sizes and timeouts.
  Every mutation stays behind the panel's session, Origin and CSRF checks and
  is recorded in the activity log.

### Single source of truth, strict ownership

There is no central `sites.json`: domain uniqueness follows naturally from file
names. The helper only modifies or deletes a file whose header is present and
byte-conformant with the format it generates. It refuses:

- an existing file it does not recognize as panel-managed;
- overwriting a managed file whose content was changed externally.

The existing activity log records who requested each operation; the file header
records which stack and service the domain belongs to.

### Concurrency: one global Caddy lock plus the per-stack lock

The panel keeps its per-stack lock (one modifying operation per stack,
including saves) and registers Caddy mutations in the shared shutdown drain.
The helper additionally serializes the whole
prepare → validate → publish → reload sequence behind an exclusive lock on
the managed directory, so two stacks attaching domains at once cannot interleave
a publish and a reload. The lock is only ever reclaimed from a provably dead
holder (a `pid` recorded in the lock, never mere age), so long validations
and reloads cannot cause overlapping mutations; external writers that reload
Caddy should ideally take the same lock, without sharing the files. Otherwise
the coordination with them is best-effort and this is documented as such.

### No network verification in V1

V1 verifies and applies the Caddy configuration only:

| Status                | V1                 |
| --------------------- | ------------------ |
| Generated config      | Verified locally   |
| Caddy config valid    | Verified           |
| Caddy reload done     | Verified           |
| DNS resolution        | Not verified       |
| HTTPS reachable       | Not verified       |

Fetching a user-supplied domain from the panel would add an SSRF surface
(redirects, private IPs, DNS rebinding) for no conclusive proof: a successful
request from the host does not prove public reachability. V1 instead offers an
`Open application` link and states what remains to be checked externally.
Network checks, if ever added, need their own ADR.

### Explicit refusal when the import is missing

`caddy validate` alone is not sufficient: an `import` glob matching no file is
not an error, and a valid configuration does not prove the main `Caddyfile`
imports the managed directory. Before publishing anything, the helper verifies
both that the active `Caddyfile` contains the required `import` directive and
that the adapted configuration (`caddy adapt`) contains the expected route.
Otherwise it refuses with an actionable message and publishes nothing.

### Safe sequence and honest rollback

```text
Prepare candidate
       ↓
Validate complete Caddy configuration
       ↓
Publish candidate atomically
       ↓
Reload Caddy
       ↓
Success / rollback
```

When the reload fails, the helper restores the previous file and reloads the
restored configuration. If that second reload also fails, the outcome is
reported as unknown and requiring intervention — never as success. `caddy
reload` uses Caddy's administration API, which must stay enabled for this
mechanism.

### Externally deployed stacks stay read-only here

Stacks carrying a `stack.managed-by` label (for example
`managed-by: external-deployer`) show their routing as read-only information
and cannot attach or detach domains through this integration. The label stays
informational, as in ADR 0025: the read-only rule is a workflow choice, not a
security boundary, and it never disables the panel's other actions.

### Activation

Opt-in. When the integration is disabled, the panel behaves exactly as before:
no Domains section, no socket access, no new dependency.

## Consequences

- Landed in two steps: first the pure domain model, validation, canonical file
  generation and a preview-only Domains section on the stack page (no
  privileged path, no mutation, no network call; `COMPOSE_PANEL_CADDY_ENABLED`
  off by default with the pure module `src/caddy.ts`), then the host helper
  with its systemd socket/service units, the bounded socket client, real
  attach/detach/status operations under both locks, the import/adapt checks,
  rollback semantics, and an end-to-end test against a disposable Caddy
  (`COMPOSE_PANEL_CADDY_SOCKET_PATH`).
- No database, no scheduler, no generic command runner, no Caddy Docker Proxy
  migration: the existing Caddy layout is kept.
- `product.md`, `architecture.md`, `security.md` and `deployment.md` carry the
  feature once PR2 lands; PR1 documents the contract in this ADR only.

## Alternatives considered

- **Caddy Docker Proxy (labels on containers)**: rejected for the existing
  host. It would require changing the Caddy installation, sharing a Docker
  network and granting the controller access to daemon metadata. Kept as a
  reasonable option for a host built from scratch, not for this one.
- **A `sudo`/`sudoers` rule executed from the panel container**: rejected. A
  `sudo` inside the container does not execute on the host.
- **A central `sites.json` registry**: rejected. It adds a second source of
  truth that can desynchronize from the Caddy files and is harder to repair by
  hand.
- **Panel-side DNS/HTTPS checks in V1**: rejected (SSRF surface, inconclusive
  signal, monitoring scope creep).
- **Editing the main `Caddyfile` from the panel**: rejected. The panel only
  ever writes files it owns in its managed directory.

## Verification

PR1: `tests/caddy.test.ts` (domain/service/stack/port validation, canonical
generation, strict header parsing, refusal of foreign or externally modified
files, loopback binding check), `tests/config.test.ts` (opt-in flag defaults
and parsing), `tests/html.test.ts` (Domains preview rendering, escaping, no
form for externally managed stacks) and `tests/app.test.ts` (section absent
when disabled, preview shown when enabled, invalid input is a warning never a
`500`). `bun run test` and `bun run typecheck` are the gates; no Docker test
is needed for PR1.

PR2: unit tests for the socket client (bounds, timeouts, malformed answers)
plus an isolated Linux end-to-end test against a disposable Caddy (attach →
adapt contains the route → reload; missing import refused with nothing
published; failed reload restores the previous file; second-reload failure
reported as unknown). Never against the host's production Caddy or daemon.
Manual verification on the target host with its real Caddy before release.

## Out of scope

Wildcard domains, path-based routing, Caddy request authentication, editing the
main `Caddyfile`, Caddy Docker Proxy support, DNS/HTTPS monitoring, automatic
retry or replay after a crash, multi-host or multi-user management.
