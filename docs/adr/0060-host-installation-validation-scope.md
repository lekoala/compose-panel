# ADR 0060 - Validation scope for host installations

Status: Accepted (2026-11-27).

## Context

[ADR 0033](0033-debian-host-installation.md) makes the installer accept four
distribution releases on two architectures: Debian 12 and 13, Ubuntu 24.04 and
26.04, on amd64 and arm64. The checklist in
[installation](../installation.md#verification-before-release) asked for a fresh
disposable systemd VM per combination, eight rows in total, and listed each as
pending until recorded.

Two rows were recorded on 2026-11-27: Debian 13 amd64 and Ubuntu 26.04 amd64.
The other six had stayed pending since ADR 0033, and a reset costs roughly half
an hour per host. The installer code path is the same for every row: one script,
one APT/systemd/Caddy sequence, one `dpkg --print-architecture` check and one
distribution/codename check that already refuses everything else. What differs
between rows is package availability in the distribution repositories, the
userland (coreutils, find, grep, stat, flock), the systemd version and the CPU
architecture.

The shared parts are already covered without a fresh host:

- ShellCheck and `bash -n` on every script, plus the documentation build.
- The installer fixtures under the Ubuntu 24.04 runner's userland and once more
  under a Debian-based Bun image, with fake Docker/systemd/Caddy executables.
- The release workflow builds and Trivy-scans both `linux/amd64` and
  `linux/arm64`.
- A real arm64 host (aarch64, Docker 29.9.2 arm64) runs the panel and the Caddy
  helper with real stacks, although on Ubuntu 22.04 with a local image, so it
  does not exercise the installer.

## Decision

The release gate is one fresh-host installer run on the newest Debian stable and
the newest Ubuntu LTS, on amd64. On 2026-11-27 that is Debian 13 and Ubuntu
26.04. For each gated row a release records a private install, HTTPS with two
logins, a reboot and a rerun, as described in
[installation](../installation.md#verification-before-release).

Every other supported combination is **best effort**: the installer still accepts
it, but no fresh-host run is required and it is never described as validated.
Its coverage is the fixtures, the checks and the multi-arch image above, plus any
opportunistic run recorded in the same checklist. A failure reported on a
best-effort target is a bug: fix it, then record the run if the fix needs one.

Support is otherwise unchanged. Debian 12 stays accepted while Docker publishes
`bookworm` packages (ADR 0033); on 2026-11-27 Docker and Caddy still publish both
`bookworm` and `trixie` repositories.

## Consequences

- [installation](../installation.md#verification-before-release) separates the
  gated rows from the best-effort rows instead of presenting six permanent
  "Pending" cells. Release notes name the rows a release actually validated.
- The arm64 installer risk is accepted and stated: the panel, the helper and the
  multi-arch image are exercised on arm64, the installer is not.
- Debian 12 is a compatibility target, not a validation target: bookworm is in
  LTS, and its Debian-specific configuration (`unattended-upgrades`
  `Origins-Pattern`) is already exercised by the Debian 13 run.
- A best-effort target that breaks in a way the installer cannot refuse safely
  (for example a repository that moves) becomes a candidate for the gate, not an
  automatic support drop.
- The scope is revisited when the gated release changes: a new Debian stable or
  Ubuntu LTS becomes the gated row and the previous one becomes best effort.

## Alternatives considered

- **Run all eight rows for each release.** The strongest evidence, at about four
  hours of disposable hosts per release for paths that share their code.
  Rejected.
- **Gate one Debian and two Ubuntu releases.** Two Ubuntu runs per release to
  cover a userland the CI runner already provides. Rejected.
- **Drop Debian 12 and arm64.** Shrinks the claim but breaks working
  installations and contradicts ADR 0033. Rejected.
