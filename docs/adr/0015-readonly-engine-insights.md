# ADR 0015 — Read-only engine and resource insights

Status: accepted.

## Context
The panel manages Compose stacks and, since ADR 0014, observes every container
through a read-only `ContainerInspector`. An operator still cannot answer three
concrete questions from one place: what is running, what consumes resources, and
what needs attention. The host-level view (load, uptime, swap, filesystems,
package updates) is unavailable because the panel runs in a container and does
not see the host namespaces; that wider view would need an optional host
component and belongs to a separate decision.

Three Docker commands give useful, already-available facts without any host
agent:

- `docker info` — static facts about the machine running the daemon (OS, kernel,
  architecture, CPU count, total memory, engine version, object counts).
- `docker stats --no-stream` — per-container CPU, memory, network and block I/O,
  and PIDs, as Docker's CLI reports them.
- `docker system df` — Docker-managed storage (images, containers, volumes,
  build cache) and how much is reclaimable.

Their costs differ sharply. `info` and `stats --no-stream` are cheap-ish and
bounded; `docker system df` walks image/container/volume filesystems and the
Docker documentation warns it can be expensive on hosts with a lot of data. A
timeout bounds the client wait, not the work already started inside the daemon.

Two mistakes must be avoided:

1. Turning the panel into a monitoring system. There is no history, no series
   store, no alerts and no daemon collecting in the background.
2. Presenting engine facts as host health. `docker info` describes the machine
   that runs the daemon (possibly a VM); `docker system df` measures Docker's own
   data, not free partition space.

## Decision
- **Extend `ContainerInspector` (`src/containers.ts`) with three read-only
  methods**: `info()`, `stats()` and `diskUsage()`. They are lower-level,
  non-Compose Docker calls, so they belong to the same boundary as `list`,
  `inspect` and `logs` (ADR 0014); the Compose lifecycle contract stays in
  `ComposeProvider`. Exactly these three methods are added: this iteration does
  not turn the inspector into a generic monitoring object. Host health and
  maintenance (the later "host insights" work) must introduce their own boundary
  rather than keep growing this one.
- **Fixed executable and explicit argument arrays, never a shell.**
  - `docker info --format {{json .}}`
  - `docker stats --no-stream --no-trunc --format {{json .}}`
  - `docker system df --format {{json .}}`
  There is no user-supplied option and no mutation.
- **A whitelist projection for `info`.** The `Info` object is large and may carry
  registry, proxy and environment configuration; only named fields are extracted
  (`insights.ts`). The raw object is never retained, logged or returned, exactly
  as `docker container inspect` is projected in ADR 0014.
- **Honest semantics.**
  - CPU is summed across a stack's containers and may exceed 100 % (Docker's
    scale is per core). It is reported as a cumulative figure, never as a share
    of total server capacity, and a usage bar is not clamped to 100 %.
  - Memory is summed in bytes; a memory limit and a memory percentage stay
    per-container. Meters derived from `MemPerc` are never summed.
  - Network and block I/O are cumulative counters, not rates, and stay at the
    container level in this iteration; they are labelled "I/O", never "/s".
  - The memory semantics of `docker stats` (the CLI subtracts page cache on
    Linux) are preserved: values are taken from the CLI output, never recomputed
    from the raw API.
- **Collection cost is respected.**
  - `info` and `stats --no-stream` are collected on page open and on an explicit
    manual refresh.
  - `docker system df` is **never collected automatically**; it is read on
    demand, behind a short in-memory cache (about five minutes). A future live
    refresh must never trigger it.
- **Unavailable is not zero.** Each collection is independent and its result is
  `null` when it could not be obtained, distinct from an empty result. If `stats`
  fails while `info` succeeds, the page keeps what it has. The loader swallows
  only expected operational failures (unavailable, timeout, unparsable output);
  a programming error still propagates.
- **Stack aggregation reuses ADR 0014 classification.** External and standalone
  containers are visible, but their usage is never added to a managed stack on a
  name resemblance; only containers classified as Managed contribute to a stack
  total.
- **"Needs attention" is a snapshot of the current state**, from data already in
  the container list: `unhealthy` and `restarting`, the problems visible now.
  An exited container whose status shows a non-zero exit code (derived from the
  `docker ps` `Status` text so no extra `inspect` is needed) is listed apart,
  folded under it as "Stopped with an error", and not counted: finished jobs
  such as CI or build steps often end that way. (Amended in 0.3.2; it was
  counted as attention before.) It carries no history and no alerting.

## Consequences
- An operator can see what runs, what consumes, and what looks wrong, on one
  read-only page, without installing anything.
- The panel's Docker surface widens again. It stays read-only and bounded, but
  the guarantee is application-level: a full panel compromise already has
  root-equivalent access through the socket. Accepted for the
  single-trusted-administrator threat model.
- Host CPU/RAM/load/uptime, swap, zombie processes, filesystems and package
  updates remain out of scope. They require a separate, optional, strictly
  allow-listed host component and its own ADR.
- Registry update checks (comparing a remote digest with the local one) are a
  distinct item and are not part of this decision.
- No history, no series database, no alerting and no background collection are
  introduced; the in-memory disk cache disappears on restart.
