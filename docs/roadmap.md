# Roadmap

0.1 covers the V1 scope in [product.md](product.md). The milestones P0–P6 that got there are recorded in [CHANGELOG.md](../CHANGELOG.md).

Nothing below is scheduled or promised. Each item changes a documented guarantee and needs its own ADR before any code.

After V1 the direction is to understand the host the stacks run on, not only the stacks themselves: observe resource use and service health, and carry out targeted server maintenance — without becoming a general-purpose Linux administration panel. Working tagline: *Manage your stacks. Understand your server.*

## Access
- **Use HTTPS and the SSH tunnel at the same time.** Done in 0.1.1 ([ADR 0012](adr/0012-multiple-access-origins.md)): `COMPOSE_PANEL_PROXY_ORIGINS` (a list) plus `COMPOSE_PANEL_ALLOW_LOOPBACK`. Host and Origin are validated per access point, and the cookie attribute is chosen per path.
- **Login CSRF across tabs and access modes.** Make the token robust when several tabs are open or the access path changes.
- **Access diagnostics (later).** Show the configured origins and a security level or warning per entry — provider-agnostic, with no Caddy/Tailscale/Cloudflare detection in the code.

## Usability
- **Move between stacks without returning to the list**: a sidebar and a search/filter.
- **Per-stack network options** from a fixed allow-list, instead of editing raw YAML for common cases (see Dockge's edit screen).

## Engine support
- **Podman.** Add a Podman `ComposeProvider` behind the existing boundary (ADR 0005). Announce compatibility only after integration tests cover `config`, `ps`, `pull`, `up`, `down`, project names and file mounts.

## Insights (read-only)
- **Per-stack and per-container CPU/RAM**, a top-consumers view, and Docker disk usage (`docker system df`), through a read-only `stats` operation added to the boundary. No new daemon, no database, no retained history: collection has a cost, so heavy probes stay off by default. Validate Podman output parity like the other commands.
- **Simplified service health**: `unhealthy`, restart loops, abnormal exits, surfaced with the stack they belong to.
- **Check a registry without pulling.** Compare a tag's remote digest with the local one so "update available" shows before any download. Needs registry credentials in the container and honest handling of rate limits, private registries and local builds (ADR 0011 covers only images already pulled).

## Host insights and maintenance
- **Read-only host status** the container cannot see through namespaces: available packages and security updates, reboot required, filesystems, swap, zombie processes. Data comes from an optional, strictly allow-listed read-only host component — no arbitrary commands, no terminal, no free `sudo`.
- **Targeted maintenance** using the distribution's own mechanism (for example `unattended-upgrades`): check, review and apply updates, then a controlled reboot with a separate confirmation. One package transaction at a time, audited, never a distribution upgrade. A single failing third-party repository should be identifiable and offered for temporary disable without blocking the rest.
- Out of scope, even here: users, firewall, package repositories, arbitrary services and distribution upgrades. Compose Panel must not be marketed as a general server management panel.

## Compose
- **Compose override files.** Stacks with `compose.override.yaml`, or several primary files, are refused today. Supporting them means editing and validating several files as one project (see ADR 0004).
