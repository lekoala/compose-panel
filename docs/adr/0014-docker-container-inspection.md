# ADR 0014 — Read-only Docker container inspection

Status: accepted.

## Context
The panel manages the Compose stacks declared in `STACKS_DIR`, but the host runs
other containers too: Compose projects that were never placed under that
directory (for example brought over from Dockge), infrastructure containers
(BuildKit), CI jobs and standalone `docker run` containers. Today those
containers are invisible: an operator cannot see why a port is taken or why the
machine uses memory when no managed stack explains it.

Adding this visibility is attractive but it widens the surface that talks to the
Docker daemon. Two mistakes must be avoided:

1. Turning Compose Panel into a container manager (Portainer). The product
   boundary is: **manage what is declared in Compose files, observe everything
   else**; never force an observed container back into a stack.
2. Confusing "read-only" with a real security boundary. Mounting the Docker
   socket `:ro` does **not** restrict the Docker API: the socket still grants
   effectively administrative power to the process that holds it. The read-only
   guarantee is **application-level** (fixed commands, explicit argument arrays,
   no mutation), not enforced by the mount.

## Decision
- **A dedicated boundary** `ContainerInspector` (`src/containers.ts`) for the
  lower-level Docker calls that are not Compose operations: `ps` (list),
  `inspect` and `logs`. The Compose lifecycle contract stays in
  `ComposeProvider` (ADR 0005); the two are not mixed. The rest of the code
  depends on the business operations, never on the argument layout.
- **Fixed executable and explicit argument arrays, never a shell.** Commands are
  `docker container ls -a --no-trunc --format <fixed template>`,
  `docker container inspect -- <id>` and
  `docker container logs --tail <n> --timestamps -- <id>`. IDs are validated
  (`^[0-9a-f]{12,64}$`) before use and passed after `--`. `docker logs` has no
  `--no-color`: ANSI escapes are stripped by the panel.
- **Read-only, by construction.** The inspector exposes no start, stop, restart,
  remove, exec or generic command. There is no user-supplied option.
- **One `ps` call for the list**, enriched with the Compose labels needed for
  classification through an explicit template (`.Label "com.docker.compose.*"`),
  each field JSON-encoded and tab-separated so a value cannot corrupt the line.
  The list never runs one `inspect` per container. `inspect` and `logs` are one
  call each, on demand.
- **A whitelist projection for `inspect`.** The raw object is never retained,
  logged or returned; only named fields are extracted (`container-state.ts`).
  `Config.Env`, `Args` and any unlisted field are dropped. Error output never
  re-exposes inspection data.
- **Three categories, derived from metadata, never from the name:**
  - *Managed* — the container provably belongs to a stack the panel discovered.
  - *External Compose* — Compose labels are present (`com.docker.compose.*`) but
    no managed stack matches; read-only.
  - *Standalone* — no Compose identity; read-only.
  A container whose membership is not certain is **External Compose**, not
  Managed. Labels are declarative metadata, not a trust signal.
- **Managed is strict.** It requires either a `config_files` path that maps to a
  discovered stack's canonical Compose file, or (only when `config_files` is
  absent) a `com.docker.compose.project` that matches exactly one deployed,
  managed project. The Docker-side `config_files` reflects the path Compose saw
  at creation, which may differ from the panel's mount
  (`/opt/stacks/...` vs `/app/stacks/...` after a Dockge migration); an optional
  alias table (`COMPOSE_PANEL_STACKS_PATH_ALIASES`) remaps known prefixes. A
  path that cannot be mapped is External Compose, never Managed by name
  resemblance.
- **Sensitive outputs are treated as sensitive.** Logs may contain tokens or
  personal data: authenticated, `Cache-Control: no-store`, never logged, `tail`
  bounded to a fixed allow-list and output capped in bytes. Mounts reveal host
  paths and are shown collapsed behind a native `<details>`. Health status comes
  from the `docker ps` template, so no `inspect` is needed for the list.

## Consequences
- An operator can explain a busy port or memory use that no managed stack
  accounts for, without gaining any way to modify that container from the panel.
- The panel gains a new Docker surface. It is read-only and bounded, but it is
  still an application-level guarantee: a full compromise of the panel already
  has root-equivalent access through the socket. This is accepted for the
  single-trusted-administrator threat model.
- Host-only services (Caddy under systemd, `tailscale`) remain invisible to
  `docker ps` and stay out of scope: they need a separate host component and its
  own ADR.
- This is a distinct roadmap item, *Docker container inspection*, not the
  broader *Server health page* (CPU, RAM, disk, host health stay separate).
