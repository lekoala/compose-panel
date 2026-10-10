# Roadmap

0.1 covers the V1 scope in [product.md](product.md). The milestones P0–P6 that got there are recorded in [CHANGELOG.md](../CHANGELOG.md).

Nothing below is scheduled or promised. Each item changes a documented guarantee and needs its own ADR before any code.

- **Podman.** Add a Podman `ComposeProvider` behind the existing boundary (ADR 0005). Announce compatibility only after integration tests cover `config`, `ps`, `pull`, `up`, `down`, project names and file mounts.
- **Compose override files.** Stacks with `compose.override.yaml`, or several primary files, are refused today. Supporting them means editing and validating several files as one project (see ADR 0004).
