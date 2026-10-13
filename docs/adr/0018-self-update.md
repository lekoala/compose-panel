# ADR 0018 — Self-update through a one-shot updater container

Status: accepted.

Amended by [ADR 0028](0028-versioned-release-registry.md): digest history is
versioned in the repository and the 72-hour wait starts from the later of
release publication and the latest registration of its digest. Failed
publication remains retryable, including a replacement image.

## Context
Updating the panel meant an SSH session on the host: pull or rebuild the image,
then `docker compose up -d` from the deployment directory. Administrators asked
for an "Update" button. The panel cannot simply run `compose up` on its own
stack: recreating its container sends `SIGTERM` to the process that runs the
command, so the update would be cut off halfway, and the panel would be gone
before it could report anything.

Following a mutable tag (`latest`) keeps the deployment simple, but on its own
it would install whatever the tag points to the moment it appears. The panel
must also install only an image the maintainer published for a release, after a
waiting period, and keep an exact way back. Pinning a version in `compose.yaml`
would mean rewriting the Compose file, which this ADR excludes on purpose.

[product.md](../product.md) listed panel self-update as out of scope. This ADR
brings it into scope, in a deliberately narrow form.

## Decision
- **The panel knows its own deployment from Docker, not from configuration.**
  It finds its own container ID in `/proc/self/mountinfo` (the
  `/containers/<id>/hostname` bind mount Docker creates), then reads the
  container's Compose labels: project, service, working directory,
  `config_files` and `environment_file`. It also reads the image reference the
  service was started from, the image ID it runs and the host source of the
  `/var/run/docker.sock` mount. Nothing comes from the browser and no new
  setting is needed. Any missing or unexpected value (not a Compose container,
  one-off container, relative path, `..`, a Compose or env file outside the
  working directory, image pinned by digest, locally built image, no socket
  mount) makes the feature unavailable with a stated reason, never a guess.
- **Official image only.** Self-update is offered only when the panel runs from
  `ghcr.io/lekoala/compose-panel` (any tag). The release source is fixed to the
  `lekoala/compose-panel` GitHub repository; it is never taken from an image
  label, which the image itself controls.
- **The release workflow publishes the identity.** After the multi-platform
  push, the workflow reads the pushed image index digest
  (`containerimage.digest` from `docker buildx build --metadata-file`) and
  creates the GitHub Release for the tag, with the line
  `compose-panel-image-digest: sha256:<64 hex>` in its body. Creating the
  release is the last step, so `published_at` is the moment everything else
  succeeded. If the release already exists (created by hand from the GitHub
  interface, or a re-run), the workflow keeps its notes and sets the digest
  line to the image it just pushed. ADR 0028 also registers that digest in Git;
  the wait counts from the later of publication and registration, so a
  replacement cannot reuse the earlier publication date. A release stays not
  installable while it has no digest line or matching registry record.
- **Check & download update = pull the panel's own tag, then verify the
  release.** It runs `docker image pull -- <reference>` with the reference the
  panel runs from and touches no container. When the tag now points to another
  image ID than the one the container runs (the ADR 0011 rule), the panel reads
  that image's `org.opencontainers.image.version` label (bare semver) and makes
  an unauthenticated request to
  `api.github.com/repos/lekoala/compose-panel/releases/tags/<version>`
  and another to the fixed `releases.json` Contents API on `master`
  (byte-bounded streams, one shared timeout, no token). The image is installable only if:
  - the release exists, is not a draft and not a prerelease, and its tag is
    exactly that version;
  - both `published_at` and the latest matching digest registration are at
    least **72 hours** old (a constant, not a setting);
  - the digest line is present and the pulled image's `RepoDigests` contains
    `ghcr.io/lekoala/compose-panel@<that digest>`. `RepoDigests` records the
    digest of what was pulled by tag, the multi-platform index, so the same
    value holds on amd64 and arm64. The local image ID is never compared to
    the release digest: they are different identities.

  Anything else (GitHub unreachable, no release, unexpected body, mismatch)
  makes the image not installable, with the reason shown. A young release
  shows when it becomes installable. The verdict is kept in memory for the
  image ID it concerns and is never fetched on page render; after a restart,
  the administrator checks again. A version tag stays on that release rather
  than following new versions, but a retried publication can replace its digest.
- **Install update = a one-shot updater container, independent of the panel.**
  On confirmation the panel re-reads the release and re-checks every condition
  above server-side (no bypass in the interface; the host CLI stays available
  for an immediate update), then starts
  `docker container run -d --name compose-panel-updater` from **the image it
  runs now** (always present locally, and its updater code matches the
  arguments the panel builds), with `--network none`, the Docker socket, and
  the deployment working directory mounted read-only at the same path. Same
  user and supplementary groups as the panel, so it reads the same files. Its
  command is `bun src/scripts/self-update.ts` with fixed, validated arguments:
  the panel container ID, the image reference, the approved target image ID and
  its expected `repository@digest`, the previous image ID, project, service,
  working directory, Compose files and env files. No shell. Its labels record
  the previous and target image IDs and versions. Its Docker and Compose calls
  run with `PATH`, `HOME` and `DOCKER_HOST` (when set) only: the panel image's `ENV` (`STACKS_DIR`,
  `PORT`) would otherwise take precedence over `--env-file` during
  interpolation and change the recreated deployment. The updater:
  1. refuses (exit 2, nothing changed) if the tag no longer resolves locally to
     the approved image ID, if that image's `RepoDigests` lacks the expected
     digest, if `compose config` no longer resolves the service to the same
     image reference, or if a `.env` exists in the working directory without
     being recorded in the container's labels (interpolation would not be
     explicit);
  2. tags the image the panel ran as `compose-panel:rollback`, and refuses if
     it cannot (a rollback must stay possible);
  3. runs `docker compose -p <project> --project-directory <dir> -f … [--env-file …]
     up -d --no-deps --no-build --pull never <service>` through the
     `ComposeProvider` boundary: the approved image is the one installed, and
     nothing is downloaded or built. A concurrent local retag of the tag between
     step 1 and this step is not defended against: there is no other Docker
     writer in the supported setup;
  4. waits (bounded) for the new container: it must be a different container,
     run the target image, and become `healthy` (the image has a health check)
     or keep running when no health check is defined;
  5. exits 0 on success, 1 on failure after the recreate started.
- **The outcome survives the replacement without a panel-owned store.** The
  updater container is not removed when it ends. Its exit code, timestamps,
  labels and bounded output stay in Docker, and the new panel reads them back
  (`container inspect` and `container logs` of the fixed name, after checking
  the updater label). Docker remains the source of truth (ADR 0002, ADR 0006):
  the panel persists nothing. The finished container is removed when the next
  update starts.
- **One update, with nothing else running.** The update is refused while any
  stack action or save runs, while any stack lock is held (including the lock
  kept after an operation whose process exit was not confirmed: the restart
  would drop that guard), while an updater container is running, or during
  shutdown. From the moment it starts, the panel refuses new actions, saves and
  backup purges until Docker confirms the updater ended or never started, or
  the panel is replaced. If the start command fails or times out, the panel
  asks Docker whether the updater exists before calling it a non-start; when
  Docker cannot tell, the outcome is shown as unknown and mutations stay
  paused. Shutdown and the session are re-checked after the Docker and GitHub
  calls, right before the updater starts. The form carries the target image ID
  shown to the administrator, and the panel re-checks it before starting.
- **Bounded wait.** The pause relies on `docker container wait`, itself bounded
  at 20 minutes. The updater ends well before that (5 minutes at most for
  `compose up`, then 3 minutes at most for the new container to become ready),
  so the bound is only reached if Docker stops answering. If it is reached,
  actions are allowed again even though the updater may still be running. This
  is accepted: it needs a stuck daemon, and a second update stays refused while
  the updater container runs.
- **Shutdown during an update.** `SIGTERM` (normally `compose up` replacing the
  panel) drains actions, saves and log follows as usual, but does not wait for
  the updater: it is a separate container and keeps running. The pause is
  in-memory and ends with the process. The new panel shows "running" while the
  updater container runs, refuses a second update meanwhile, then shows the
  outcome read from Docker. The same holds if the panel is stopped or crashes
  during an update.
- **Security.** Both endpoints are mutations: session, allowed Origin and CSRF
  token, refused during shutdown, recorded in the activity log
  (`self-update-check`, `self-update`). The updater gets the same Docker socket
  the panel already has, so it adds no privilege. It only ever runs the fixed
  steps above on the panel's own service, with `--no-deps`: other services and
  managed stacks are not touched.
- **Rollback and recovery are manual and use the exact previous image.** No
  automatic rollback. The page shows the previous and target versions and image
  IDs, the updater output, and two sets of host commands
  ([deployment.md](../deployment.md#upgrade-and-rollback)): roll back (re-tag
  `compose-panel:rollback` as the panel's image reference, then
  `up -d --no-deps --no-build --pull never <service>`; no file edited, nothing
  downloaded), and redo the update by hand (`pull`, then `up -d --no-deps`).

## Not decided here
- Checking a registry without pulling (roadmap, ADR 0011).
- Choosing a specific version, or rewriting the image reference. Following
  `latest` only ever offers the newest release, even when an older one is
  eligible and the newest is still young.
- Signatures (Cosign) and provenance attestations: a later improvement of the
  publishing chain.
- Updates on a schedule or without a click (no scheduler), and an automatic
  rollback.
- Installs outside the documented Docker deployment (no container, a
  `DOCKER_HOST` other than the mounted socket, Podman, a locally built image,
  another image repository).

## Consequences
- Updating from the browser takes two clicks (check, then install) and one
  confirmation. Sessions live in memory, so the administrator signs in again
  after the restart.
- The panel makes its first outbound request (GitHub API), only on an explicit
  check or install. Unauthenticated rate limits (60 requests per hour per
  address) are far above that use.
- The 72-hour delay is an interface policy, not a daemon restriction: the
  pulled image stays usable by a manual `docker compose up` on the host.
- The deployment files on disk are applied as they are: a change made to them
  since the panel started is applied too, as with a manual `compose up`.
- A failed updater leaves the panel container in whatever state Compose left
  it. The outcome is visible on the next panel start, or from the host with
  `docker logs compose-panel-updater`.
- `compose-panel:rollback` keeps the previous image from being treated as
  dangling. `docker image prune -a` still removes it while no container uses it.
- The panel image now carries a second entry point,
  `src/scripts/self-update.ts`.
