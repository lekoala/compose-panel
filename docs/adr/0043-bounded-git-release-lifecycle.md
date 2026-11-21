# ADR 0043 — Bounded Git release lifecycle

Status: Accepted (pilot scope)

## Context

Some stacks run code that lives on the host and is bind-mounted into a
container. Their deployment today is a manual `git pull` over SSH plus
`docker compose up`, with no record of which commit is served, no atomic
switch and no honest rollback. Image-built stacks are different: a Git fetch on
the host deploys nothing, and their CI/tagged-image path (ADR 0011, ADR 0041)
must stay unchanged.

The project has no orchestrator, no generic job framework, no durable operation
queue and no host command runner exposed to the browser. A deployment therefore
needs a deliberately narrow lifecycle, bounded transport, a fixed probe and the
existing lock, operation view and audit trail — not a mini-PaaS.

ADR 0042 defines the site manifest, the release layout and the `current`
pointer. This ADR defines how a release gets there and how failure is reported.

## Decision

The panel offers a **manual, bounded deployment of one operator-configured Git
ref into an immutable release**, followed by an atomic pointer switch, a runtime
recreation, a fixed revision probe and, on a failed probe, a probed code
rollback. There is no scheduler, no webhook, no image build and no database
migration in this increment.

### Eligibility

All of the following, revalidated under the stack lock before anything is
fetched:

- `COMPOSE_PANEL_MANAGED_SITES_ENABLED=true` and a valid manifest (ADR 0042);
- `deploy.kind: "bind-mount"`; an image-only stack is refused with an
  actionable message that points to its CI/image path;
- the declared gateway and runtime services exist in `config --services`;
- the gateway publishes exactly one TCP port on `127.0.0.1` and the runtime
  publishes none;
- no service in the project joins a network marked `external: true`, and the
  gateway and runtime share at least one project network; the site's own
  project network is the isolation boundary (ADR 0042);
- both services mount `<stack>/site/runtime` at the same absolute source and
  destination, read-only, with no mount destination at or below
  `runtime/current`, no parent bind, no alias of a release path, no
  `volumes_from`, no non-canonical path and no mount of `staging/`, `private/`
  or the checkout in any service (ADR 0042); names and `deploy.kind` alone
  prove nothing;
- the runtime service runs an explicit image reference (no implicit `latest`,
  no local `build:` in the release path), and that reference still resolves to
  the local image ID of the running runtime container: `--pull never` would
  otherwise recreate the container on a different already-present image under
  the same tag, so the pilot refuses that drift instead of changing the
  application runtime underneath the rollback target;
- the effective project name is resolved before `-p` is injected (a `name:` in
  the Compose file never overrides it), the manifest is re-read under the stack
  lock at every deploy, and the effective Compose project, `-f` files, project
  directory and `.env` interpolation still match it; any drift refuses
  (ADR 0042);
- the baseline is provable before any stop: `current` validates, its release
  metadata is complete, and the probe reports exactly the commit SHA that
  `current` targets. A first deployment without a rollback target is not
  offered in the pilot;
- the gateway configuration reserves the fixed revision probe path; a site
  without that route is refused at activation, never verified by a weaker
  signal.

A second stack is never touched by a deploy of the first: every call carries an
explicit project, working directory and files.

### Fetch and staging

- One fetch per site at a time, within the existing per-stack lock and project
  reservation.
- Public HTTPS only in this increment. The URL and the fully qualified ref come
  from the manifest; nothing comes from the browser except the stack name and a
  confirmation.
- Clone/fetch into `site/staging/<attempt-id>` on the release filesystem, then
  resolve the fetched ref to a full 40-hex commit SHA. A short ref, a wildcard,
  an ambiguous branch or an annotated-tag object that does not resolve to a
  commit is refused.
- The transport uses a fixed `git` executable and explicit argument arrays, no
  shell. Inherited configuration is disabled: no system or global config, no
  hooks, no credential helper, no terminal prompt, no askpass, no redirect
  following, no submodule recursion, and a protocol allow-list limited to the
  declared transport. `HOME`, `XDG_CONFIG_HOME` and any Git cache point into a
  panel-owned private directory.
- Time, downloaded bytes, disk use and output capture are bounded. Exhaustion
  cleans up only the attempt's staging directory, after proving it belongs to
  the attempt.
- The checkout is content, never configuration: it is not mounted into the
  panel, not executed by the panel and not read as Compose or env input. The
  release never contains `.git`; an optional bare fetch cache stays under
  `site/private/git/`.

### Release preparation

- The staged tree is completed in `site/staging/<attempt-id>`: `public/` and
  `public/index.php` are present, the panel-written
  `/.compose-panel/revision.php` sits outside `public/` and emits the full SHA,
  and completed-release metadata (`version`, `siteId`, `release`, `status:
  "complete"`) is written under `site/private/releases/<sha>.json`. A staged
  tree without the front controller, or with a symlink, a gitlink/submodule, a
  `.git` entry or a repository-supplied `.compose-panel`, is refused before
  publication. Symlinks and submodules are refused from the `ls-tree` object
  before any checkout, so a filesystem that materialises them differently
  cannot hide one.
- Publication is one exclusive rename to `site/runtime/releases/<sha>`. A
  release directory is never overwritten or republished: an existing non-empty
  directory cannot be replaced by rename, and an existing release for the same
  SHA is only revalidated against its metadata and revision script. A directory
  that exists but is not marked complete for that SHA refuses.
- No Composer, npm or build step in this increment. A fixed, disposable,
  unprivileged preparation container is a later increment with its own
  isolation contract: only the staging path writable, no Docker socket, no
  production credentials or database, no writable production data, bounded
  output and resources, and a required dependency lockfile.

### Activation

The ordering is part of the contract:

```text
lock the stack, reserve the project
  → revalidate manifest, profile, identity, mounts and drift
  → verify the baseline: pointer, metadata and probe agree on the served SHA
  → fetch the configured ref, resolve the full SHA
  → if the probe already serves that SHA and pointer + metadata agree: no-op
  → stage, then publish the immutable release
  → write the attempt record (attempt ID, intended SHA, prior release)
  → stop the gateway service, confirm it is stopped
  → atomically rename current -> releases/<sha>
  → force-recreate the runtime service (resets OPcache and the realpath cache)
  → start the gateway service
  → probe /.compose-panel/revision on the verified loopback binding
  → compare the served SHA with the intended SHA
```

- The probe is one bounded GET against the service's actual `127.0.0.1` TCP
  binding, read through the existing `ContainerInspector` first. Fixed path, no
  redirects, no user-supplied URL, no DNS lookup, no TLS. It must answer HTTP
  `200` with a body of exactly 40 lowercase hexadecimal characters followed by
  one newline (41 bytes), retried within one five-second total deadline. Any
  other status, size, encoding or timeout is a failed verification.
- Stopping the gateway, switching the pointer and force-recreating the runtime
  is a brief serving interruption. It is documented, not hidden: the site is
  unavailable between stop and start.
- The pointer switch is one rename on the same filesystem. It is atomic; the
  running containers follow it because `runtime/` — not `current` — is mounted
  (ADR 0042).
- The runtime is always force-recreated after a switch, even when the code
  looks identical: a pointer switch changes neither the image nor the Compose
  configuration, and a long-lived PHP process caches the resolved script path
  and compiled code. Only a new process is guaranteed to serve the new release.
- Retrying a SHA is a no-op **only** when the pointer, the release metadata and
  the probe all agree on it. Otherwise it is an ordinary deployment.
- An attempt record that cannot be written stops the deployment before any
  serving change; the record is what makes a later crash inspectable.

### Failure policy

| Failure | Behavior |
| --- | --- |
| Manifest, profile, identity, mounts or drift check | refuse before any fetch; active release untouched |
| Baseline disagreement (pointer, metadata or probe) | refuse before any fetch or stop; nothing changes |
| Fetch, SHA resolution, bounds | clean up only the proven attempt; active release untouched |
| Staging or publication | clean up only the proven attempt; active release untouched |
| Gateway fails to stop, or its state is unconfirmed | `unknown`; keep the attempt marker; do not switch; require inspection |
| Pointer rename | atomic: either the old or the new target; an unconfirmed rename is `unknown` |
| Runtime recreation or gateway start | report the phase; the pointer may already be new, so the site is reported as requiring inspection, never as deployed |
| Probe mismatch or failure | return the pointer to the verified baseline, force-recreate the runtime, start the gateway, probe the baseline SHA; report `rolled back` only when that probe succeeds |
| Any command whose exit cannot be confirmed | `unknown`; keep the stack lock; never retry automatically |
| Panel crash at any point | `unknown`; no replay; the operator inspects |

- Before activation, cleanup deletes only files or containers proven to belong
  to the attempt (attempt ID, identity labels, creation time, absence from the
  initial snapshot).
- After the pointer switch, nothing is deleted automatically. An old release is
  kept for rollback and inspection.
- The selected SHA and the verified serving SHA are shown separately whenever
  they differ or verification is unavailable. A failed verification is never
  rendered as success.

### After a panel restart

The panel reads the pointer, the Compose service state and the local probe, and
reports them separately. An attempt record without a terminal outcome means
`needs inspection`: no operation is resumed, no deployment is started
automatically, and the stack lock is not assumed to be held by a dead process.
While that marker exists, every modifying operation on the stack is refused —
deploy, Up/Down/Start/Stop/Restart, raw save and application actions — while
reads, logs and the probe remain available. An explicit operator
acknowledgement after inspection clears the marker; a restart, a timer or a new
request never does. Bounded attempt records are evidence, never a durable queue
(ADR 0002, ADR 0006).

### Boundaries

- A new fetch/publish adapter owns Git and filesystem staging. It is not part of
  `ComposeProvider`, which stays the Compose CLI boundary (ADR 0005).
- `ComposeProvider` gains service-scoped `stopService` and `startService`, and
  an explicit `force` option on `recreateService` used only by deploy and
  rollback (`up -d --no-deps --no-build --pull never --force-recreate --
  <service>`).
  The self-update call keeps its non-forced form. A pointer switch changes
  neither the image nor the Compose configuration, so the forced form is the
  only one that actually replaces the container. The deploy asserts that the
  runtime container ID changed and that the gateway container ID did not.
  Arguments are fixed and the service name is validated against
  `config --services`.
- The operation is a named entry in the existing operations manager, with the
  existing bounded output and SSE view. No new job framework.
- Audit event `deploy` records the site ID, attempt ID, intended SHA, prior
  release, phase, outcome and, on failure, a fixed reason. It never records
  output, repository content or file content.

### Security

- The manifest is administrator-authored; the browser sends identifiers only.
  No URL, ref, path, command or option comes from a request.
- Secrets are not used by the fetch in this increment (public HTTPS). A later
  private-repository increment adds a read-only key and a pre-provisioned
  `known_hosts` as separate files with their own ADR-level review; a host key is
  never accepted on first use.
- The release tree is untrusted content: no symlinks, no submodules, no
  executable expectation, and never interpreted as Compose, env or runner
  configuration.
- Deploy holds the per-stack lock through verification and rollback, refuses
  during shutdown and self-update, participates in the maintenance exclusion and
  cannot overlap another stack operation.

## Consequences

- A known commit can be deployed from the browser, the served revision is
  verified and a failed activation returns to the previous code with a probed
  result.
- The panel gains one fetch/publish adapter, two service-scoped provider calls
  and one route. It gains no scheduler, no webhook, no image build, no migration
  runner and no durable deployment history.
- Pilot deployments require a verified baseline release: a failed probe always
  has a target to return to, and an unprovable baseline is refused before the
  first stop. There is no first deploy without rollback in the pilot.
- The forced recreation is a new, explicit provider capability; the
  self-update path keeps its current one.
- The brief gateway outage is part of the contract. Zero-downtime deployment is
  not claimed; the existing rollout (ADR 0035) is incompatible with a
  loopback-port gateway and is not reused here.
- Private repositories, Composer builds, CI triggers, migrations, workers,
  backups and production cutover remain out of scope.

## Alternatives considered

- **`git pull` in the working tree, then `up`.** Rejected: a dirty tree, no
  immutable release, no atomic switch, no probe and no rollback.
- **Change the bind path and rely on `compose up`.** Rejected: Compose does not
  recreate a service for a changed bind target in general, and the running
  container keeps the old mount.
- **Mount `current` into the containers.** Rejected: the container keeps the
  old target across a switch (ADR 0042).
- **A host deploy script or webhook runner.** Rejected: it is arbitrary host
  execution exposed to the network, outside the fixed-command model.
- **Build the release image on the host.** Rejected for this increment: it is a
  separate capability with its own trust and resource contract.
- **Copy the whole working tree on each deploy.** Rejected: no immutability, no
  verifiable provenance and no bounded cleanup.
- **Persist deployment state in a database or queue.** Rejected (ADR 0002): a
  crash leaves an unknown outcome, and the operator reconciles from the pointer,
  Docker and the probe.
- **Skip the runtime recreation and rely on file timestamps.** Rejected: PHP's
  realpath cache and OPcache are per process; only a new process proves the
  loaded revision.

## Verification

Unit tests: ref/SHA validation, full-SHA requirement, path containment and
symlink/submodule refusal, staging layout, attempt-record bounds, probe parsing
(status, exact 41-byte body, lowercase hex, timeout) and the rollback decision
table (no-op only when proven active, rollback only when identity and state are
certain). Provider tests cover the forced versus non-forced recreation argv and
the service-scoped stop and start. Profile tests cover every service, not just
the declared pair: parent binds, release aliases, `tmpfs` overlays,
`volumes_from`, non-canonical paths, external networks and the shared project
network.

Linux integration, disposable only: `scripts/managed-sites-lab/run.sh` runs on
its own Docker-in-Docker daemon and proves the mount/switch/recreate contract
without the panel, including the runtime container ID changing while the
gateway's stays, the effective mounts, the pinned OPcache policy actually
loaded by the runtime, the release readable by an unprivileged UID, the probe
format and `/` answering the same SHA. The deployment suite adds a local bare
repository and a fake fetch adapter to deploy two commits, verify the served
SHA, fail an activation and roll back, with a second stack unchanged. Never
against a host daemon running real stacks, never in unattended CI.

VM checklist:

1. Deploy commit A, then commit B; the probe reports each SHA and the API
   reports the selected SHA separately.
2. Deploy A again while A is active: no-op, no release directory added.
3. Break the probe on B: the pointer returns to the verified baseline, the
   runtime is force-recreated (its container ID changes), the baseline probe
   succeeds, and the report says `rolled back` with both SHAs.
4. Kill the panel between the stop and the switch, then between the switch and
   the probe: the next load reports `needs inspection`, shows the pointer, the
   Docker state and the probe separately, refuses every modifying operation on
   that stack, and starts nothing.
5. Failed fetch, wrong ref, oversized repository, a symlink in the tree and a
   changed `site/runtime` mount: the active release stays untouched, the
   operation is refused before any stop and the reason is actionable.
6. An image-only stack and a stack without a valid manifest: the route is
   absent or refuses with nothing fetched.
7. A baseline whose pointer, metadata and probe disagree: refused before any
   stop.

## Out of scope

CI/webhook triggers, private Git over SSH, Composer/npm builds, database
migrations, background workers, preview environments, zero-downtime activation,
automatic retry or replay, scheduled deployments, multi-host deployment and
production cutover/cloning.
