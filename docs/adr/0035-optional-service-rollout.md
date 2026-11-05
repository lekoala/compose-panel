# ADR 0035 — Optional native service rollout

Status: accepted

## Context

`Up` and `Pull + up` replace a service's containers in place. For a single
service that can run two instances at once, an administrator may want a short
overlap: start the new instance, wait for it to become healthy, let a reverse
proxy discover it, drain the old instance, then stop and remove only the old
container.

The project deliberately has no orchestrator, no generic job framework and no
durable operation queue. It also has a fixed action allow-list and no arbitrary
Docker command. Adding a rolling deployment therefore needs a deliberately
narrow decision, not a plugin or a general deployment engine.

`docker-rollout` implements a similar mechanism, but embedding it would add an
external binary and its own options, logs and release cadence. The useful part
is small; the failure handling is not. This ADR chooses a native implementation
with a strict scope.

## Decision

The panel offers an **opt-in rollout of one explicitly declared service**, with
no general zero-downtime guarantee, conditional cleanup **before** drainage and
candidate preservation **after** any drainage attempt.

### Activation

Two independent gates:

- Global: `COMPOSE_PANEL_ROLLOUT_ENABLED=true` (default `false`). When off,
  there is no route, no button and no extra Docker read.
- Per service: `panel.rollout.enabled: "true"` in the service labels.

The declaration is read from the resolved Compose config through the
`ComposeProvider`; only the `panel.rollout.*` keys are projected. The folder
name is never assumed to be the project name.

### Declaration

| Label | Bounds | Default | Role |
| --- | --- | --- | --- |
| `panel.rollout.enabled` | exactly `"true"` | absent = off | Opt-in |
| `panel.rollout.timeout` | integer 1..600 s | 120 | Candidate health timeout |
| `panel.rollout.settle` | integer 0..60 s | 5 | Wait after healthy before marking the old |
| `panel.rollout.drain-file` | absolute POSIX path, no `..`, no control characters, ≤ 200 chars | absent | Drain marker |
| `panel.rollout.drain-detect` | integer 5..300 s | 30 | Maximum wait for the old to report `unhealthy` |
| `panel.rollout.drain-time` | integer 5..300 s | 20 | Propagation and in-flight request window |
| `panel.rollout.stop-timeout` | integer 1..300 s | 30 | Passed to `docker stop --time` |

Out-of-range values are refused, never clamped. `drain-detect` and `drain-time`
require `drain-file`.

The drain marker is an **application contract**: the path must be writable by
the container user, on the container's writable layer (for example `/tmp`), and
checked by the healthcheck. The panel never removes it. A marker on a mounted
path is refused because two instances could share it and become unavailable
together. The contract must already be present on the old container; otherwise
the administrator is asked to run `Up` once first.

### Execution

```text
lock the stack
  → authoritative revalidation
  → optional pull of the service image
  → snapshot the single existing container
  → compose up -d --no-deps --no-recreate --no-build --pull never
      --scale <service>=2 -- <service>
  → identify exactly one new container
  → wait for it to be healthy and to run the expected local image
  → settle
  → optional drain:
        docker exec <old> touch <drain-file>
        wait until the old reports unhealthy (drain-detect)
        wait drain-time, re-check the candidate
  → docker stop --time <stop-timeout> <old>
  → docker remove <old>
  → verify the candidate and complete
```

`stop_grace_period` governs `docker compose stop`; this action passes its own
`--time` and does not consult it. The documentation states this explicitly.

### Eligibility

Hard refusals:

- the service is not declared, or the declaration is invalid;
- `build:` is present (V1 rolls out images only);
- `container_name` is present;
- `ports` are published;
- `deploy.replicas` or `scale` is not absent or 1;
- `network_mode` is `host`, `none`, `service:*` or `container:*`;
- `ipc`/`pid` is `host`, `service:*` or `container:*`;
- `volumes_from` is non-empty;
- another service shares this service's namespaces or volumes;
- a fixed `ipv4_address`/`ipv6_address` is declared;
- the service has no image;
- the service does not have exactly one container in any state;
- that container is not running or not healthy;
- the effective healthcheck is absent.

### Failure policy

- The first drain attempt (the marker, or the stop in a marker-less rollout) is
  an **irreversible boundary**.
- Before it, a created candidate may be removed only when its identity is
  proven: full container ID, the four Compose identity labels matching the
  operation context, a creation date after the operation started, and absence
  from the initial snapshot. The old container must also still be running and
  healthy at cleanup time; otherwise the candidate is kept because it may be
  the last available instance.
- After it, nothing is removed automatically. A failure is reported as an
  **intervention**; the candidate is kept.
- A command whose exit could not be confirmed is `unknown`, keeps the stack
  lock and is never cleaned up automatically.
- A crash of the panel leaves the outcome unknown. There is no persistence, no
  journal and no replay. The operator reconciles with Docker.

### Boundaries and security

- `ComposeProvider` gains `pullService`, `scaleService`, `serviceContainerIds`
  and `serviceRolloutFacts`. Only allow-listed facts leave it.
- A new, narrow `ContainerMutator` boundary owns `docker container stop`,
  `docker container remove` and `docker container exec <id> touch <path>`.
  `ContainerInspector` stays read-only (ADR 0014). The command is fixed; only
  the validated path comes from the declaration. Removal never uses `--force`
  and never removes volumes.
- The route reuses the existing mutation guards: session, Origin, CSRF,
  per-stack lock, shutdown/self-update refusal and audit. Audit events use the
  `rollout` name.
- The panel stores nothing and adds no dependency.

### Proxy requirement

A reverse proxy must discover both instances, route only to healthy ones and
stop routing to the old one before it is stopped. This is an operational
prerequisite, not something the panel certifies.

The existing Caddy site integration attaches a **published loopback port**;
rollout refuses published ports. Those Caddy routes are therefore **not** a
compatible path and must not be presented as one. A compatible setup uses a
container-discovery proxy such as Traefik on a shared network.

## Consequences

- A service that can run two instances can be replaced with a short overlap and
  a bounded drain.
- The panel gains a small deployment phase machine, three container-level
  mutations and one new optional route. It does not gain a general orchestrator,
  a scheduler, multi-service rollouts, automatic migrations, automatic rollback,
  persistent history or crash recovery.
- No general zero-downtime guarantee is made. Long requests, shared storage,
  database migrations, healthcheck design and proxy behaviour remain the
  administrator's responsibility.
- A first activation of a drain marker can require one ordinary `Up` so the
  running container carries the contract.
- Integration tests run on a disposable lab daemon with a real proxy; they stay
  opt-in and never run in unattended CI.

## Alternatives considered

- **Embed `docker-rollout`.** Less initial code, but an external binary to
  version, adapt and observe. Rejected because the useful mechanism is small and
  the project wants no third-party runtime.
- **Generalize `Up`.** Rejected: it would silently change the existing action's
  behavior and its downtime expectations.
- **Allow an arbitrary drain command.** Rejected: it would add arbitrary
  command execution through a label, against the fixed-command model.
- **Persist rollout state.** Rejected for V1: no database and no durable queue
  (ADR 0002); a crash leaves an unknown outcome and the operator reconciles.
