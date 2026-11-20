# ADR 0041 — Targeted pull, and a remote image check that stays honest

Status: accepted (2026-11-20). **Part A** (targeted pull) ships with this ADR.
**Part B** (remote check) is decided here and implemented in a follow-up change:
none of its routes or provider methods exist yet.

## Context

`Up` and `Restart` already accept one validated service (ADR 0021), but `Pull`
is stack-wide only. An administrator who wants to patch PHP-FPM or Nginx without
touching the other services has to download the whole stack. That is the most
concrete gap between the panel and the operational need — *apply a corrected
image without redeploying the application* — and it costs almost nothing to
close.

"Update ready" (ADR 0011) is derived locally: it compares the image a container
runs with the image its tag points to **now**, so it can only speak after a
`Pull`. Nothing tells the administrator that a tag moved upstream before
downloading it. ADR 0011 deferred that on purpose, listing registry credentials,
rate limits, private registries and locally built images as open problems.

The panel must not become an image-resolution engine. It needs one reliable
answer — does the tag move? — and an honest `unknown` everywhere else.

## Decision A — `pull` accepts one service

- The operations route allows a `service` field for `up`, `restart` and `pull`,
  and keeps refusing it everywhere else.
- The service is validated against the **effective Compose project** first
  (`compose config --services` with the pinned `-p`, `--project-directory`, `-f`
  and `--env-file`), exactly like a scoped `up`, then passed after `--`.
- **An explicit Pull means "refresh now".** The command is
  `pull --ignore-buildable --policy always`. Compose 5.8.0 skips a versioned tag
  that is already present when the service declares `pull_policy: missing` or
  `if_not_present`, and always under `never`, so a plain `compose pull` would
  exit 0 without downloading anything — the panel would report success and
  leave the tag stale. `--policy always` rewrites the selected services' policy
  for that invocation only; `up` keeps honouring the declared policy. A
  `build:` service is still excluded by `--ignore-buildable`, which is evaluated
  after the policy decision, so Pull never stands in for a rebuild (ADR 0022).
- **The scope is the service, not "nothing else".** `compose pull <service>`
  narrows the project to that service, but Compose also pulls images referenced
  by that service's lifecycle hooks (`pre_start`) and image-backed volumes,
  because they run as part of it. The panel does not reimplement that
  resolution; it promises "the selected service and what Compose pulls for it",
  never "exactly one image".
- No container is touched, and nothing about the lock, SSE, shutdown or audit
  model changes. A scoped pull on a stack that was never deployed stays allowed:
  it downloads images and creates nothing.
- `ComposeProvider.pullService` (rollout, ADR 0035) now delegates to the same
  code path, so the two cannot diverge.

## Decision B — remote check: three facts, one comparison, no engine

### Three facts, never merged

Per service the panel keeps three distinct things and never presents one as
another:

| Fact | Source |
| --- | --- |
| `running` | the image the container runs (existing) |
| `local` | what the tag resolves to locally (existing, ADR 0011) |
| `remote` | what the registry says the tag resolves to (new, on demand) |

Verdicts: **Update available** (`remote ≠ local`), **Update ready**
(`local ≠ running`), **Up to date** (all three equal), **Unknown** with a reason.
A failed or unavailable check never clears a marker already derived locally: an
unreachable registry must not hide a downloaded update.

### Explicit, background, single-flight

- A check is an explicit `POST` from the stack page: session, Origin, CSRF,
  audit event `image-check`. The page render path stays local-only and never
  performs network I/O.
- It runs in the background like an operation, with a bounded timeout, and the
  result is read on the next page render. Only one check runs at a time for the
  whole panel.
- The last result is kept in memory per stack. There is **no TTL cache**: every
  press of Check queries the registry again, so a just-published image is never
  answered from a stale cache.
- A successful `Pull` invalidates the stored result, because the `local` fact
  changed.
- **A check in flight can never publish a stale verdict.** Each check records,
  before it queries anything, the stack's *local-state generation* (a counter
  incremented after every completed stack mutation, including Pull) and the
  exact set of `service → image reference` it resolved. When it finishes it
  re-reads, for every verified reference, the local digest it started from.
  It publishes only if all three still match: same generation, same references,
  same local digests. A Pull, a save or a Compose edit that lands meanwhile
  therefore discards the result instead of overwriting a fresher one, and the
  page asks for another check. The final re-read also catches a change made
  outside the panel that the counter cannot see. A verdict is always attached to
  the reference that was actually verified, so it can never be displayed for a
  service whose image changed in between.
- Measured cost: ~3.0 s per image on a development host through Docker Desktop,
  12.9 s inside a nested `dind`. The 5 s default subprocess timeout is therefore
  too short; the check uses its own bound (30 s) and never blocks a page. It does
  not take the stack lock (it is read-only and must not delay an urgent **Up**),
  which is exactly why the generation check above is required.
- Unknown reasons are classified (`not-found`, `unauthorized`, `rate-limited`,
  `timeout`, `invalid-output`, `unsupported`) so the administrator sees one
  sentence, not raw registry output.

### Tool: `docker buildx imagetools inspect`, not `docker manifest inspect`

`docker manifest inspect` is still documented *experimental* ("may change
between releases without warning or can be removed"), and the spike showed two
concrete problems: 25 s per call, and a hard failure when addressing a child
manifest by digest (`manifest verification failed for digest`). Rejected.

`docker buildx imagetools inspect --format '{{json .Manifest}}'` is a documented
interface over structured data, returned the same shape for a public index, a
single-entry index and a bare tag, and needs no running builder for registry
reads. It requires the `docker-buildx-plugin` apt package, pinned in the
`Dockerfile` like `docker-ce-cli` and `docker-compose-plugin` (17 MB, Debian 13
trixie, scanned by Trivy with the rest of the image).

### Comparison rule: by capability, `Unknown` when the local side is ambiguous

The remote side is always the **top-level digest the tag resolves to**
(`--format '{{json .Manifest}}'` → `.digest`). The local side — *which digest this
tag was pulled from* — is not uniformly exposed, so the rule resolves it by
capability and refuses to guess:

1. **`.Descriptor.digest` when it is present** and its `mediaType` is an index or
   an image manifest. The containerd store exposes it per reference, which makes
   it the exact recorded digest for that tag.
2. **Else a single unambiguous `RepoDigests` entry** for the same normalized
   repository. This is the classic store's common case (one image per
   repository).
3. **Else `Unknown`** with the reason `ambiguous-local-digest`, when no digest is
   recorded, when the entry is malformed or `<none>`, or when several digests of
   that repository are recorded for the tag.

`RepoDigests` membership alone is **not** a valid test, and the spike proves it:
two tags of the same repository resolved from two different indexes that share
the same local child (the same amd64 image) are the **same image** on the classic
store, and both index digests end up in the list of that one image. Membership
would then answer "up to date" for a tag pointing anywhere in that set — a false
negative, the worst outcome. `docker images --digests` does not rescue it: on the
classic store it prints **one row per recorded digest**, so a tag appears twice
with both digests and no per-tag answer. On the containerd store the same
experiment is unambiguous: each tag keeps its own `.Descriptor.digest` and a
single `RepoDigests` entry.

The alternative — comparing the remote **platform config digest** with the local
image ID — was the first proposal and is rejected on evidence:

- classic store (`overlay2`): `.Id` **is** the config digest, so it would work;
- containerd store (`overlayfs`, the default of Docker 29 on a fresh Debian 13):
  `.Id`, `.Descriptor.digest` and `RepoDigests` are all the **index digest**
  (`sha256:d9e853…`), while the platform config digest is `sha256:bf8527…`. The
  local config digest is not exposed at all (`Metadata` and `Identity` are null,
  `.Descriptor` describes the index, and the only way to obtain it would be a
  full `docker save` or reading the containerd store directly).

On that store the proposed rule would report a permanent, unfixable "update
available". The capability-based rule was verified on both stores.

### Platform

The service `platform:` field is therefore **not** consulted for V1: the
resolved digest already covers every platform the tag publishes, and the panel
does not need to know which one the service runs.

Known limitation, accepted: a republish that changes **only another
architecture** changes the tag digest, so the panel shows `Update available`
while the service's own image content is unchanged. Verified behaviour: `docker
pull` in that exact case also reports `Downloaded newer image` and rewrites the
local digest. The verdict describes what **Pull** would change for the tag,
which is what the next action does — and the ADR 0011/0032 wording already
states consequences rather than causes.

Refining this would need the local platform config digest, which the containerd
store does not expose. Not attempted.

### Scope and refusals

- Only `image:` references with a mutable tag are tracked. `build:` services
  (ADR 0022), digest-pinned references and bare image IDs are `not tracked`,
  without any network call. A `build:` service can only receive a base-image
  fix through a rebuild, which is CI's job — the panel says so instead of
  implying an omission.
- No credential storage or UI. The CLI reads its own client configuration, so an
  operator can mount a read-only `DOCKER_CONFIG` directory with least-privilege
  `auths` entries. Verified: `401 Unauthorized` without it, `not found` (auth
  accepted) with it, and a push + inspect through the same config. Pull and
  Check therefore share one configuration — a stack can never be pullable and
  uncheckable, or the reverse. Credential helpers (`credsStore`) are absent from
  the image and produce `unknown`, which is stated in the documentation.
- No CVE claim. A different digest proves neither a fix nor compatibility; the
  panel never says "security update". A remote version label is not displayed:
  it is not reliably present in a manifest.
- The image reference is validated before reaching the CLI (no scheme, no
  userinfo, bounded length) and passed after `--`. Output parsing keeps only
  bounded fields. Raw registry output is never rendered or logged.

## Spike evidence

Run on 2026-11-20 on a development host (Docker Desktop, daemon 29.8.2,
`overlay2`) and inside a disposable privileged `docker:29.9.0-dind` container
(daemon 29.9.0, `overlayfs`, containerd store), with a local `registry:2` and an
htpasswd-protected `registry:2`.

| # | Case | Result |
| --- | --- | --- |
| 1 | Package availability | `docker-buildx-plugin` 0.37.1 → 0.39.1 available for Debian 13 trixie (17 MB) |
| 2 | `imagetools inspect` without a builder | Works; resolved a public multi-arch index with no buildkit instance |
| 3 | `--raw` on a tag | Returns the index, **without** a top-level digest field |
| 4 | `--format '{{json .Manifest}}'` | Returns `mediaType`, `digest` and `manifests[]` — the digest is available |
| 5 | `--raw` on `<ref>@sha256:<child>` | Returns the child manifest with `.config.digest` |
| 6 | Classic store | `Id` = config digest `bf8527…`, `RepoDigests` = index digest `d9e853…`, `.Descriptor` null |
| 7 | Containerd store | `Id` = `RepoDigests` = `.Descriptor.digest` = index digest `d9e853…` |
| 8 | Remote vs local, both stores | Remote index digest `d9e853…` equals the recorded digest in both |
| 9 | Republish: same amd64 child, new arm64 child | Index digest changes (`54d37c…` → `cca7a1…`); `docker pull` also reports `Downloaded newer image` |
| 10 | Missing tag / missing repo | Exit 1, `ERROR: <ref>: not found` |
| 11 | Private registry, no credentials | Exit 1, `unexpected status from HEAD request … : 401 Unauthorized` |
| 12 | Same, with `DOCKER_CONFIG` `auths` | `not found` (auth accepted); push + inspect succeed through the same file |
| 13 | Latency | `imagetools` 3.0 s (host) / 12.9 s (nested dind); `manifest inspect --verbose` 25 s; local `image inspect` 50 ms |
| 14 | Single-child `imagetools create` | Still an index with one entry, so the index path is the normal one |
| 15 | `docker manifest inspect <ref>@sha256:…` | Fails: `manifest verification failed for digest` |
| 16 | Explicit pull and `pull_policy: missing` | `compose pull` skips a present versioned tag ("Image is already present locally", exit 0); `--policy always` rewrites the policy for that run |
| 17 | Two tags, two indexes, same amd64 child — classic store | Same image ID (`bf8527…`); **both** index digests (`54d37c…`, `cca7a1…`) in the `RepoDigests` of either tag; `docker images --digests` prints each tag twice |
| 18 | Same scenario — containerd store | Each tag keeps its own `.Descriptor.digest` and a single `RepoDigests` entry; `docker images --digests` prints one row per tag |

Method: isolated `dind` containers and throwaway local registries, all removed
afterwards; locally built test tags removed. No deployed stack was touched.

## Rejected alternatives

- **Compare the platform config digest with the local image ID.** Not portable,
  and wrong by construction on the containerd store (see above).
- **`RepoDigests` membership, or `docker images --digests`, as the local side.**
  Disproved: two indexes sharing one local child collapse onto the same image on
  the classic store, so both digests are attached to both tags (row 17). A
  membership test answers "up to date" for a tag pointing at the other index —
  a false negative. `--digests` lists each tag once per recorded digest, so it
  cannot arbitrate either.
- **Keep the declared `pull_policy` for an explicit Pull.** It turns the button
  into a no-op with `missing`/`never` while still reporting success, which is
  the opposite of what the action promises and of what ADR 0011 describes.
- **Index digest as a "fast path" only.** Inverted by the evidence: it is the
  rule, because it is the only comparison both stores expose. Per-platform
  refinement is dropped instead.
- **A registry API client inside the panel** (Bun `fetch`, `WWW-Authenticate`
  token flow, reading `~/.docker/config.json`). Duplicates Docker's own
  authentication, needs credential handling and a credential model the project
  does not want, and adds SSRF surface for no benefit.
- **Install nothing and use `docker manifest`.** Experimental, slower, and
  broken on digest-addressed children.
- **TTL cache and per-stack single-flight.** More machinery than a manual check
  needs, and a TTL cache is exactly what makes a freshly published image look
  missing. One global check, last result in memory, no cache.
- **Declarative policy labels** (`panel.updates.policy: manual|notify|auto`).
  `manual` is the default and `auto` has no executor, so two of the three states
  would be a contract with no effect. The eligibility information such a label
  would carry (locally built image, digest-pinned reference, missing healthcheck,
  rollout unavailable) is shown directly, with no declaration.
- **A scheduler or an internal timer.** Out of scope (ADR 0002). Recurring
  checks belong to a host timer; applying an update from a machine trigger needs
  its own ADR, because it changes the access model (see the roadmap's
  *Trigger rollout from CI*).

## Consequences

- Patching one containerized runtime no longer requires pulling the whole stack.
- `Pull` now downloads even when the stack declares `pull_policy: missing` or
  `never`. That is a deliberate behaviour change for the existing stack-wide
  action: an explicit click means refresh, and `Up` still honours the declared
  policy. An air-gapped `never` service therefore fails loudly instead of
  silently doing nothing.
- The panel gains one pinned runtime dependency, one new outbound network
  capability, one in-memory result per stack and one audit event. It gains no
  scheduler, no credential store, no database and no image-resolution engine.
- The check answers "would Pull change this tag?", which is what the next action
  does. It does not answer "is this image patched for CVE-x", and the wording
  must never imply it does.
- On the classic store, two tags of the same repository that resolved from the
  same local image make the check say `Unknown` instead of comparing. That is
  the intended cost of never inventing an answer.
- `build:` services remain out of reach by design; a corrected base image still
  needs a CI rebuild and republication.

## Verification and rollback

The comparison code is not written until the multi-tag case below has been
reproduced on **both** image stores; the spike already did it (rows 17–18), so
the contract is known before implementation.

- Unit tests: verdict decisions and reason classification, reference validation,
  the capability-based local-digest resolution (descriptor present, single
  unambiguous `RepoDigests` entry, ambiguous → `unknown`), the publish guard
  (generation, references and local digests), the provider argument arrays
  (`--policy always`, `--` before a service), and the route guards (service
  validation, CSRF, Origin, single-flight, audit).
- Lab tests on a disposable daemon, with the embedded Compose on Linux and never
  in unattended CI:
  1. a versioned tag already present and then republished: the panel's Pull
     fetches the new digest, while a plain `compose pull` skips it;
  2. the same under `pull_policy: never`: an explicit Pull still refreshes;
  3. two tags of one repository resolved from two indexes that share the local
     image: no false `up to date` — `unknown` on the classic store, a correct
     comparison on the containerd store (both stores are exercised);
  4. a check started before a Pull of the same service: its verdict is discarded,
     never published;
  5. a scoped Pull of a service that declares a `pre_start` hook image: the hook
     image is pulled too, which is what the scope promise says;
  6. an htpasswd registry read through `DOCKER_CONFIG`, and `not found`, `401`
     and a forced timeout all reported as `unknown`; a `build:` service and a
     digest-pinned reference making no call.
- Rollback: revert the change. No data migration, no Docker resource is created
  by the check, and the only persistent effect of Part A is a pulled image.
