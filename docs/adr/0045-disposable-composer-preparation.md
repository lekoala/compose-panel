# ADR 0045 — Disposable Composer preparation for a managed release

Status: Accepted (managed-site pilot). Amended by
[ADR 0057](0057-digest-pinned-tool-images.md): the Composer image reference is
now pinned by digest as well as by tag.

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
  for whatever PHP the Composer image happens to run.

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
- The image is one fixed reference, `composer:2.10.3`, the first 2.10 release
  that fixes CVE-2026-59944 (a package binary symlink could change permissions
  outside its package and register a runnable `vendor/bin` entry during a
  normal install). `--no-scripts --no-plugins` do not disable that code path, so
  the image version is part of the security contract and the lab runs the same
  reference. Only Composer runs in it; project code is never executed.
  `composer install` is invoked with `--no-interaction --no-dev --no-progress
  --prefer-dist --no-scripts --no-plugins --optimize-autoloader --no-ansi`.
- The repository must commit `composer.lock` and must not commit `vendor/`.
  A committed vendor tree could carry install metadata from another run, which
  is the second path affected by CVE-2026-59944; the build always starts from
  source and produces the only `vendor/` in the release.
- The lock is verified twice, before any install:
  - `composer.json` must declare `config.platform.php` for the site's PHP
    channel (`8.3.x` or `8.4.x`);
  - `composer.lock` must carry `platform-overrides.php` for the same channel.
    `composer install` uses the lock's `platform-overrides`, not
    `composer.json`; an absent or different value would silently verify the
    dependencies against the Composer image's PHP or a stale platform.
  - A separate read-only, network-disabled `composer validate --no-check-publish
    --no-check-all` container refuses a lock that is stale relative to
    `composer.json` or that `composer.json` cannot describe. A stale lock is not
    accepted with a warning.
- Two disposable containers per attempt:
  - the offline lock check runs read-only with `--network none` and no writable
    tree;
  - the install runs with the staging tree mounted at `/src`, `--user
    <staging-owner-uid>:<gid>`, `--read-only`, `--cap-drop ALL`,
    `--security-opt no-new-privileges`, and bounded memory, CPU and PID count.
    `COMPOSER_HOME` and `COMPOSER_CACHE_DIR` live on a bounded `tmpfs`; they
    never touch the release filesystem.
  - Neither container receives a Docker socket, a panel environment variable, a
    secret file, a production mount or a database. `COMPOSER_BIN_COMPAT=proxy`
    keeps `vendor/bin` free of symlinks, and the existing staged-tree check
    still refuses every symlink in the release.
- Writes to the release filesystem are bounded during the install: the tree is
  checked every 250 ms for both bytes and file count, and the install is
  aborted when it exceeds the release cap. The cache is already hard-bounded by
  its tmpfs, and a free-space preflight keeps the release cap plus a 256 MiB
  overshoot window available. The post-build inspection enforces the exact
  file/byte/depth cap.
- The Composer image is reached through the default bridge network for package
  registries. Private registries and credentials are out of scope. The
  container can reach whatever that bridge can reach, like any build; a host
  that needs stricter egress must constrain the daemon or provide a proxy,
  because the panel does not manage networks.
- Time, output, memory, CPU and process count are bounded. Each container has a
  unique fixed name; after every run (success, failure, timeout, cancellation)
  the panel runs `docker rm -f` and then proves the name is absent from
  `docker ps -a`. If that proof fails, the attempt is kept and the deploy
  reports an unknown outcome instead of releasing the lock or cleaning up.
- Panel shutdown is wired to the build. SIGTERM/SIGINT aborts the same signal
  used by the Git fetch and the Composer containers before the operation drain;
  the cleanup uses a 4 s per-command budget so both `docker rm -f` and the
  `docker ps -a` proof fit inside the default 30 s shutdown grace. A SIGKILL
  cannot be handled; the container name prefix remains visible for inspection.
- The same preparation is applied to the first **Publish baseline** release and
  to every deploy. A managed site without `build` keeps the previous behavior.

## Failure policy

| Failure | Behavior |
| --- | --- |
| Missing/unsafe `composer.json` or `composer.lock`, missing or mismatched `config.platform.php`, missing or mismatched lock `platform-overrides.php`, committed `vendor/` or reserved tree entry | refuse before creating a container; active release untouched |
| Stale or invalid lock (`composer validate`) | refuse before the install; active release untouched |
| Less free space than the bounded release cap plus headroom | refuse before creating a container; active release untouched |
| Composer exits non-zero | remove the container, delete the attempt, report a fixed reason without echoing Composer output |
| Timeout, output limit, size cap or cancellation | remove the container, delete the attempt, report the phase |
| Container removal cannot be proven | keep the attempt and report an unknown outcome; every modifying operation stays blocked |
| Missing `vendor/autoload.php` after a successful run | delete the attempt; nothing is published |
| Prepared tree over its cap, or containing a symlink | delete the attempt; nothing is published |

## Consequences

- A managed site can serve a normal Composer application without running
  Composer on the host or in the panel, and the lock is verified for the PHP
  channel the site actually runs.
- The panel gains one build adapter and one manifest field. It gains no image
  build, no registry credential store, no scheduler and no generic runner.
- The build needs registry access and free space on the release filesystem.
  The pinned `composer:2.10.3` image must be pullable or cached on the host; the
  panel does not pull it in advance. Failures are reported before activation,
  so rollback is not involved.
- The size guard is a monitored cap, not a filesystem quota: a very fast writer
  can overshoot within one 250 ms interval. The preflight headroom and the
  post-build inspection bound the result, the tmpfs cache cannot grow on disk,
  and the same monitor stops a runaway file count before it exhausts inodes.
- npm, asset pipelines, custom scripts and plugins remain out of scope.

## Verification

Unit tests cover the fixed argv and isolation flags of both containers, the
offline lock check, the pre-Docker refusals (lock file, composer platform, lock
platform-overrides, committed vendor, reserved path, symlink, staging path),
removal confirmation, a sanitized failure reason, the size monitor, cancellation
and the missing autoloader. The disposable Linux suite runs the real
`composer:2.10.3` image: a fresh zero-dependency lock succeeds and leaves no
container, a lock whose dependency needs PHP 8.4 is refused on the 8.3 channel,
and a SIGTERM sent while the install blocks on a FIFO stops the container and
proves it removed.
