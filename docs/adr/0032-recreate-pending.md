# ADR 0032 — "Recreate pending" from the Compose configuration hash

Status: accepted.

## Context
After editing `.env` or `compose.yaml`, nothing tells the administrator which
running services still use the previous configuration. The intuitive action,
**Restart**, is the wrong one: `docker compose restart` restarts the existing
container with its old environment, mounts and options. Only **Up** recreates a
container from the current configuration. The
[runtime settings pattern](../integrations/runtime-settings.md) relies on this
distinction to apply PHP/Bun settings from `.env`, so the panel should make it
visible instead of relying on the administrator to remember it.

Compose already records what it needs. Every container it creates carries a
`com.docker.compose.config-hash` label, the hash of that service's resolved
configuration at creation time. `docker compose config --hash=<services>`
prints the hash of the current configuration, and `up` recreates a container
when the two differ. ADR 0011 shows "Update ready" for the image side of the
same question; this ADR covers the configuration side.

## Decision
- **"Recreate pending" is derived locally, without changing anything**, every
  time a deployed stack page is rendered: for each service with at least one
  container, the `com.docker.compose.config-hash` label of its containers is
  compared with the hash `compose config --hash` prints for that service now.
  A difference means **Up** would recreate that service with the current
  configuration.
- **Same project context as a mutation.** The hash call runs with the stack's
  explicit project name, `--project-directory`, `-f` file and `--env-file`
  (invariant 5), so the comparison reflects what **Up** would actually use, not
  a guess from the folder name. It sits behind the `ComposeProvider` boundary
  as a read-only method with fixed arguments.
- **Compose 5.5.0 or later only.** Before 5.5.0, `config --hash` hashes the
  service without resolving its environment (`env_file:` is not merged into
  `environment`), while containers are created from the resolved form: a
  stack using `env_file:` would always look pending. The provider reads
  `compose version --short` at startup; below 5.5.0, or when the version
  cannot be parsed, the feature is unavailable and no marker is shown. The
  embedded Compose (pinned in the `Dockerfile`) is the validated version; the
  lab suite runs against it. `--no-resolve-env` is never passed.
- **Services that reference another service's container are excluded.** For
  `network_mode`, `ipc` or `pid` set to `service:<name>`, and for
  `volumes_from`, Compose resolves the reference to `container:<id>` before
  hashing at create time and in `up`'s own comparison, while `config --hash`
  hashes the declared form. The two never match, so the marker would stay
  after a successful **Up**. The panel detects these services from Docker,
  not from the raw configuration: a container whose `HostConfig.NetworkMode`,
  `IpcMode` or `PidMode` starts with `container:`, or whose
  `HostConfig.VolumesFrom` is not empty, gets no marker ("no information").
  This also excludes a declared `container:<name>` that would hash
  consistently; the exclusion is deliberately conservative. Re-implementing
  Compose's reference resolution in the panel is rejected: it depends on
  Compose internals that changed between releases.
- **Only hashes leave the subprocess.** `compose config --hash` prints
  `<service> <hash>` lines. The panel parses only lines matching a known
  service name followed by 64 hex characters and discards everything else,
  including stderr, which may echo interpolated values. Raw resolved
  configuration is never read, logged or rendered (invariant 6).
- **One `container inspect` gives both the hash and the references.** The
  containers listed by the existing `compose ps --all` call are inspected
  once, through the existing read-only `inspectContainers` provider method.
  From each record the panel reads only `Config.Labels` entries
  `com.docker.compose.service` and `com.docker.compose.config-hash` (accepted
  only as exactly 64 hex characters) and the four `HostConfig` fields above.
  The labels string of `ps` is not parsed: it joins values with commas that
  the values themselves may contain. With several replicas, any container
  whose hash differs makes the service pending. Stopped containers count:
  **Up** recreates them too.
- **Wording states the consequence, not a cause.** The panel says that **Up**
  will recreate the service, not that "the configuration changed". If the
  containers were created by another Compose version that hashes differently,
  the panel's Compose would still recreate them on **Up**, so the statement
  stays true. The converse is not claimed: no marker does not mean **Up** will
  leave the service alone (image digest, network or volume mismatches and
  parent recreation are decided by Compose separately).
- **UI.** In the Services table, a pending service shows a "Recreate pending"
  marker next to the existing per-service **Up** form (ADR 0021), with a short
  note that **Restart** does not apply configuration changes. Server-rendered,
  no JavaScript, no new action.
- **Any failure means "no information"**, never an invented state: Docker
  unavailable, timeout, truncated output, an unknown service in the output, a
  missing or malformed label, or a stack whose project context cannot be
  verified.

## Not decided here
- Changes Compose does not hash. Inline `configs:` / `secrets:` with
  `content:` do not change the service hash (verified with Compose 5.6), nor
  does editing a bind-mounted file on the host. The panel cannot detect those
  and does not claim to; the marker only covers what Compose itself would act
  on.
- Network or volume definition changes that Compose handles separately from
  the service hash.
- Image changes: already covered by "Update ready" (ADR 0011). The two markers
  are shown independently.
- Any automatic **Up** after a save, or a combined "Save and apply" action: the
  save contract (ADR 0004) stays unchanged.

## Consequences
- The safe path after editing `.env` becomes visible: save → read "Recreate
  pending" on the affected services → **Up** on those services.
- Each deployed stack page render runs two more short read-only calls
  (`config --hash` and `container inspect`), bounded by the existing process
  timeout and output caps.
- The lab suite must cover, on an isolated daemon with the embedded Compose:
  a changed `.env` value used through `environment:` makes only that service
  pending; the same through `env_file:` does too, and an unchanged `env_file:`
  stack shows no marker; **Restart** leaves it pending; **Up** clears it; a
  service with `network_mode: service:<parent>` or `volumes_from` gets no
  marker before or after **Up**; a changed inline `configs.content` does not
  mark it (documents the known gap); malformed or missing labels yield no
  marker. Unit tests cover the version gate (below 5.5.0, unparsable output).
