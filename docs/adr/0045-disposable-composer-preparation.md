# ADR 0045 — Disposable Composer preparation for a managed release

Status: Accepted (managed-site pilot)

[ADR 0043](0043-bounded-git-release-lifecycle.md) deliberately shipped no build
step. A real PHP project usually needs `vendor/`, and running Composer on the
host would execute repository code next to the panel. This ADR adds the one
fixed preparation the pilot accepts.

## Context

- The fetched tree is untrusted content and must stay outside the panel's
  process, mounts and configuration.
- The panel has no image build, no generic job framework and no host command
  runner exposed to the browser.
- A release is published immutably before activation. A failed preparation must
  leave the active release untouched and must not leave a container behind.
- Dependencies must be resolved for the PHP runtime the site actually uses, not
  for whatever PHP the panel happens to run.

## Decision

- A managed site may declare `build: { "kind": "composer" }` in its v1
  manifest. The field is refused for `owner: "opt-in"`: an opt-in stack keeps
  its own dependency preparation (application toolbox or CI). The creation form
  exposes one checkbox; the browser never supplies an image, command or
  argument.
- The build runs as the existing `prepare` phase of
  `fetchAndPublishGitRelease`, inside `site/staging/<attempt-id>/tree`, after
  the source tree has been inspected and before the immutable publication. A
  refusal or failure removes only this attempt's staging directory (unless the
  container removal is unconfirmed) and leaves `current` and every published
  release untouched.
- The image is one fixed reference, `composer:2.8`. Only Composer runs in it;
  project code is never executed. `composer install` is invoked with
  `--no-interaction --no-dev --no-progress --prefer-dist --no-scripts
  --no-plugins --optimize-autoloader --no-ansi`.
- The repository must commit `composer.lock`. It must also declare
  `config.platform.php` for the site's PHP channel (`8.3.x` or `8.4.x`), so the
  committed lock is resolved and verified for the runtime the site actually
  runs even though Composer itself runs on a newer PHP. Missing, mismatched or
  unparsable declarations are refused before any container is created.
- One disposable container per attempt, with:
  - only the staging tree bind-mounted (at `/build`) and writable;
  - `--user <staging-owner-uid>:<gid>`, `--read-only`, a bounded `/tmp` tmpfs,
    `--cap-drop ALL`, `--security-opt no-new-privileges`, bounded memory, CPU
    and PID count;
  - no Docker socket, no host network, no panel environment, no secret file, no
    production data or database mount;
  - `COMPOSER_HOME`/`COMPOSER_CACHE_DIR` under a scratch directory inside the
    staging tree, removed after a successful build; `COMPOSER_BIN_COMPAT=proxy`
    keeps `vendor/bin` free of symlinks, and the existing staged-tree check
    still refuses every symlink in the release.
- The Composer image is reached through the default bridge network for package
  registries. Private registries and credentials are out of scope. The
  container can reach whatever that bridge can reach, like any build; a host
  that needs stricter egress must constrain the daemon or provide a proxy,
  because the panel does not manage networks.
- Time, output, memory, CPU and process count are bounded. The container has a
  unique fixed name; after every run (success, failure, timeout, cancellation)
  the panel runs `docker rm -f` and then proves the name is absent from
  `docker ps -a`. If that proof fails, the attempt is kept and the deploy
  reports an unknown outcome instead of releasing the lock or cleaning up.
- After a successful build, the prepared tree is re-inspected with its own
  explicit file/byte/depth cap (larger than the fetched source cap) before the
  revision script is written and the release is published.
- The same preparation is applied to the first **Publish baseline** release and
  to every deploy. A managed site without `build` keeps the previous behavior.

## Failure policy

| Failure | Behavior |
| --- | --- |
| Missing/unsafe `composer.json` or `composer.lock`, missing or mismatched `config.platform.php` | refuse before creating a container; active release untouched |
| Less free space than the bounded release cap | refuse before creating a container; active release untouched |
| Composer exits non-zero | remove the container, delete the attempt, report a fixed reason without echoing Composer output |
| Timeout, output limit or cancellation | remove the container, delete the attempt, report the phase |
| Container removal cannot be proven | keep the attempt and report an unknown outcome; every modifying operation stays blocked |
| Missing `vendor/autoload.php` after a successful run | delete the attempt; nothing is published |
| Prepared tree over its cap, or containing a symlink | delete the attempt; nothing is published |

## Consequences

- A managed site can serve a normal Composer application without running
  Composer on the host or in the panel.
- The panel gains one build adapter and one manifest field. It gains no image
  build, no registry credential store, no scheduler and no generic runner.
- The build needs registry access and free space on the release filesystem.
  The pinned `composer:2.8` image must be pullable or cached on the host; the
  panel does not pull it in advance. Failures are reported before activation,
  so rollback is not involved.
- npm, asset pipelines, custom scripts and plugins remain out of scope.

## Verification

Unit tests cover the fixed argv and isolation flags, the single writable mount,
the pre-Docker refusals (lock file, platform, symlink, staging path), removal
confirmation, a sanitized failure reason, the missing autoloader and the
manifest/form wiring. The disposable Linux suite runs the real image against a
local zero-dependency fixture and proves that `vendor/autoload.php` is created,
the scratch directory is removed and no `compose-panel-build-*` container
survives.
