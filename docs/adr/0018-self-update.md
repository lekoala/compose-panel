# ADR 0018 — Self-update through a one-shot updater container

Status: accepted.

## Context
Updating the panel meant an SSH session on the host: pull or rebuild the image,
then `docker compose up -d` from the deployment directory. Administrators asked
for an "Update" button. The panel cannot simply run `compose up` on its own
stack: recreating its container sends `SIGTERM` to the process that runs the
command, so the update would be cut off halfway, and the panel would be gone
before it could report anything.

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
- **Check = pull the panel's own tag.** "Check for updates" runs
  `docker image pull -- <reference>` with the reference the panel runs from.
  It touches no container. An update is ready when the tag now points to a
  different image ID than the one the container runs, the same rule as
  ADR 0011. Tracking a mutable tag (`latest`, which the release workflow pushes
  next to each version tag) is what makes this useful; a pinned version tag
  never moves, so the page says there is nothing newer. Choosing a version or
  rewriting the image reference in the Compose file is not part of this ADR.
- **Update = a one-shot updater container, independent of the panel.** On
  confirmation the panel starts
  `docker container run -d --name compose-panel-updater` from **the image it
  runs now** (always present locally, and its updater code matches the
  arguments the panel builds), with `--network none`, the Docker socket, and
  the deployment working directory mounted read-only at the same path. Same
  user and supplementary groups as the panel, so it reads the same files. Its
  command is `bun src/scripts/self-update.ts` with fixed, validated arguments:
  the panel container ID, the image reference, the expected target image ID,
  project, service, working directory, Compose files and env files. No shell.
  The updater:
  1. refuses (exit 2, nothing changed) if the tag no longer points to the
     target image the administrator confirmed, if `compose config` no longer
     resolves the service to the same image reference, or if a `.env` exists in
     the working directory without being recorded in the container's labels
     (interpolation would not be explicit);
  2. runs `docker compose -p <project> --project-directory <dir> -f … [--env-file …]
     up -d --no-deps --no-build --pull never <service>` through the
     `ComposeProvider` boundary;
  3. waits (bounded) for the new container: it must be a different container,
     run the target image, and become `healthy` (the image has a health check)
     or keep running when no health check is defined;
  4. exits 0 on success, 1 on failure after the recreate started.
- **The outcome survives the replacement without a panel-owned store.** The
  updater container is not removed when it ends. Its exit code, timestamps and
  bounded output stay in Docker, and the new panel reads them back
  (`container inspect` and `container logs` of the fixed name, after checking
  the updater label). Docker remains the source of truth (ADR 0002, ADR 0006):
  the panel persists nothing. The finished container is removed when the next
  update starts.
- **One update, with nothing else running.** The update is refused while any
  stack action or save runs, while an updater container is running, or during
  shutdown. From the moment it starts, the panel refuses new actions, saves and
  backup purges until the updater ends (`docker container wait`) or the panel
  is replaced. The form carries the target image ID shown to the
  administrator, and the panel re-checks it before starting.
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
- **Recovery is manual and documented.** No automatic rollback. When an update
  fails, the page shows the updater output and the host commands to run from
  the deployment directory ([deployment.md](../deployment.md#upgrade-and-rollback)).

## Not decided here
- Checking a registry without pulling (roadmap, ADR 0011).
- Choosing a specific version, or rewriting the image reference.
- Updates on a schedule or without a click (no scheduler).
- Installs outside the documented Docker deployment (no container, a
  `DOCKER_HOST` other than the mounted socket, Podman, a locally built image).

## Consequences
- Updating from the browser takes two clicks (check, then update) and one
  confirmation. Sessions live in memory, so the administrator signs in again
  after the restart.
- The deployment files on disk are applied as they are: a change made to them
  since the panel started is applied too, as with a manual `compose up`.
- A failed updater leaves the panel container in whatever state Compose left
  it. The outcome is visible on the next panel start, or from the host with
  `docker logs compose-panel-updater`.
- The panel image now carries a second entry point,
  `src/scripts/self-update.ts`.
