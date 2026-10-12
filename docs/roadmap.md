# Roadmap

0.1 covers the V1 scope in [product.md](product.md). The milestones P0–P6 that got there are recorded in [CHANGELOG.md](../CHANGELOG.md).

Nothing below is scheduled or promised. Each item changes a documented guarantee and needs its own ADR before any code.

After V1 the direction is to understand the host the stacks run on, not only the stacks themselves: observe resource use and service health, and carry out targeted server maintenance — without becoming a general-purpose Linux administration panel. Working tagline: *Manage your stacks. Understand your server.*

## Access
- **Use HTTPS and the SSH tunnel at the same time.** Done in 0.2.0 ([ADR 0012](adr/0012-multiple-access-origins.md)): `COMPOSE_PANEL_PROXY_ORIGINS` (a list) plus `COMPOSE_PANEL_ALLOW_LOOPBACK`. Host and Origin are validated per access point, and the cookie attribute is chosen per path.
- **Login CSRF across tabs and access modes.** Make the token robust when several tabs are open or the access path changes.
- **Access diagnostics (0.2.0).** A read-only `/access` page done in 0.2.0 ([ADR 0013](adr/0013-access-diagnostics.md)): it lists the configured paths with an honest status (verified by the panel / configured but unverifiable / verify externally) and never shows an access as secure from its configuration alone. No extra privileges.
- **Optional host diagnostics (later).** Detect Caddy/Tailscale from a bounded, read-only JSON status file produced by an optional local collector with strictly limited permissions (`systemctl is-active caddy`, `tailscale status|serve|funnel --json`), disabled by default, served to the panel through a read-only mount — never a Tailscale or systemd socket, no keys or raw config. Own ADR first. Provider-agnostic: no Caddy/Tailscale detection hard-coded beyond the collected file.
- **Server health page (later).** Fold the access diagnostics into a broader host view: external containers, systemd services and exposed ports, still read-only and without becoming a general Linux administration panel.

## Usability
- **Move between stacks without returning to the list.** Done in 0.2.0 ([ADR 0016](adr/0016-navigation-sidebar.md)): a persistent sidebar carries the section links, the stack list with the current stack highlighted, a local search filter, and a native mobile disclosure. Names only: no status, counter, badge or Docker call in the navigation.
- **Per-stack network options** from a fixed allow-list, instead of editing raw YAML for common cases (see Dockge's edit screen).

## Engine support
- **Podman.** Add a Podman `ComposeProvider` behind the existing boundary (ADR 0005). Announce compatibility only after integration tests cover `config`, `ps`, `pull`, `up`, `down`, project names and file mounts.

## Insights (read-only)
- **Deployment metadata.** Done ([ADR 0023](adr/0023-deployment-metadata.md)): per-container OCI version, revision, source and local repository digests; separately declared `stack.*` labels for environment, branch, build and application links. No CI API or registry query.
- **Docker container inspection.** Done ([ADR 0014](adr/0014-docker-container-inspection.md)): a read-only view of the containers running on the host that are not part of a managed stack: status, image, published ports, restart policy, health, mounts (collapsed) and on-demand logs, via a dedicated `ContainerInspector` boundary. Categories (`Managed`, `External Compose`, `Standalone`) are derived from Compose labels, never from the name. Distinct from the host server-health page below.
- **Per-stack and per-container CPU/RAM**, a top-consumers view and Docker disk usage (`docker system df`). Done ([ADR 0015](adr/0015-readonly-engine-insights.md)): the read-only `/server` page reads `info`/`stats` on load and `system df` on demand behind a short TTL cache, with no daemon, database or retained history. Remaining: validate Podman output parity like the other commands.
- **Simplified service health**: `unhealthy`, restart loops, abnormal exits, surfaced with the stack they belong to. A current-state version (`unhealthy`/`restarting`, with non-zero exits listed apart) ships with `/server` (ADR 0015); restart-loop detection needs history and stays future.
- **Check a registry without pulling.** Compare a tag's remote digest with the local one so "update available" shows before any download. Needs registry credentials in the container and honest handling of rate limits, private registries and local builds (ADR 0011 covers only images already pulled).

## Host insights and maintenance
- **Read-only host status** the container cannot see through namespaces: available packages and security updates, reboot required, filesystems, swap, zombie processes. Data comes from an optional, strictly allow-listed read-only host component — no arbitrary commands, no terminal, no free `sudo`.
- **Targeted maintenance** using the distribution's own mechanism (for example `unattended-upgrades`): check, review and apply updates, then a controlled reboot with a separate confirmation. One package transaction at a time, audited, never a distribution upgrade. A single failing third-party repository should be identifiable and offered for temporary disable without blocking the rest.
- Out of scope, even here: users, firewall, package repositories, arbitrary services and distribution upgrades. Compose Panel must not be marketed as a general server management panel.

## Self-update
- **Update Compose Panel from the browser.** Done in 0.3.0 ([ADR 0018](adr/0018-self-update.md)): About pulls the panel's own tag, then a one-shot updater container recreates only the panel service and waits for it to be healthy; the outcome is read back from Docker. Remaining: choosing a specific version (it would mean rewriting the image reference in the Compose file), and noticing a newer image without pulling it (see *Check a registry without pulling* above).

## Compose
- **Compose override files.** Stacks with `compose.override.yaml`, or several primary files, are refused today. Supporting them means editing and validating several files as one project (see ADR 0004).
