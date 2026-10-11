# ADR 0013 — Access diagnostics, native only

Status: accepted.

## Context
The panel can be reached through several paths at once ([ADR 0012](0012-multiple-access-origins.md)):
an SSH tunnel on loopback and one or more HTTPS proxy origins (Caddy, Tailscale
Serve, Cloudflare Access + Tunnel, …). An operator has no single place to see
which paths are configured, and a "green" indicator would be misleading: most of
the real protection (a VPN, an IP allow-list, a firewall rule, an identity
proxy) lives outside the panel and cannot be confirmed from inside it. Marking
an origin "secure" because a `remote_ip` line exists in a config the panel
cannot even read would be a false assurance.

## Decision
- **A read-only access diagnostic page**, `GET /access` ("Access & security"),
  behind authentication, `no-store`. It shows the access point the current
  request arrived on and a table of the configured paths with an honest status.
- **Three explicit states**, never conflated:
  - *Verified* — the panel checked and controls it (loopback bind, administrator
    authentication, CSRF/Origin checks, the https scheme of a proxy origin);
  - *Configured* — declared in settings but not verifiable here (a proxy origin's
    network restriction; that the loopback path is enabled);
  - *Verify externally* — not knowable from the panel (whether a tunnel is open,
    whether a firewall/VPN/allow-list/identity proxy actually restricts access).
- **No extra privileges.** The page is computed from the panel's own
  configuration and the resolved access point. It runs no host command, reads no
  Tailscale or systemd socket, and mounts nothing new. Detecting `caddy` or
  `tailscale` is out of scope for 0.1.1.
- **An invariant for the product:** the panel never displays an access as secure
  or verified on the basis of declared configuration alone. It distinguishes
  what it knows, what it has checked, and what it cannot know.

## Consequences
- Operators get an honest inventory of the configured access paths and an
  explicit prompt to verify the network-level protection themselves.
- No dependency on Caddy, Tailscale or Cloudflare is introduced; the page stays
  provider-agnostic.
- Richer host diagnostics (is Caddy active? is Tailscale Serve configured?) are
  deferred: they need a bounded, read-only status file produced by an optional
  local collector with strictly limited permissions, which is a separate change
  and its own ADR. A broader server-health page comes later still.
