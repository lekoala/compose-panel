# ADR 0033 — Debian host installation

Status: accepted

## Context

[ADR 0031](0031-ubuntu-installer.md) added one supported host family, Ubuntu
Server 24.04/26.04, and listed Debian as needing its own decision. Debian is a
documented target of Docker Engine (12 bookworm, 13 trixie, amd64 and arm64)
and of the Caddy stable repository, which publishes a distribution-independent
`any-version` suite. Every component the installer provisions — APT, systemd,
Docker CE and Caddy — is therefore available and supported by its vendor.

The installer itself, however, refuses any host that does not identify as
Ubuntu, and it hard-codes Ubuntu everywhere a distribution is named: the
supported-host check, the expected codenames, the console header and both
Docker repository URLs. The rest of the installation logic is already
distribution-neutral: the APT source search reads `sources.list` and
`sources.list.d` (so Debian's deb822 files are covered), the Caddy repository
is the same, and package, service and file checks use shared tooling.

The installer also promises daily security updates. That promise rests on two
independent pieces: the APT periodic policy it writes, and the origin list
shipped by `unattended-upgrades`. Ubuntu writes `Allowed-Origins`, Debian
writes `Origins-Pattern`; on Ubuntu the default list includes the security
archive, and on Debian the packaged default does too, but an administrator
policy can remove it. Checking only the timer never established the promise.

## Decision

Extend the supported host table of `scripts/install.sh` to four explicit
distribution/release/codename pairs:

| Distribution | Release | Codename | Architectures |
| --- | --- | --- | --- |
| Debian | 13 (stable) | trixie | amd64, arm64 |
| Debian | 12 (oldstable) | bookworm | amd64, arm64 |
| Ubuntu | 24.04 LTS | noble | amd64, arm64 |
| Ubuntu | 26.04 LTS | resolute | amd64, arm64 |

The distribution, its release and its codename are validated together, so a
derivative distribution, an unsupported release and a mismatched codename are
all refused exactly as before. Debian 13 is the recommended target for new
installations; Debian 12 stays listed while its Docker packages exist.

Docker's APT repository path follows the distribution family
(`/linux/debian` or `/linux/ubuntu`); the suite stays the detected codename and
the repository file keeps Docker's deb822 layout. Caddy, the helper, the
Compose project and the panel deployment are unchanged.

Security-update origins are now checked read-only, before and after
installation: the effective `Unattended-Upgrade` configuration is dumped and
must contain this release's security archive (`<codename>-security` or
`label=Debian-Security`), whichever syntax the installed policy uses. Ubuntu's
ESM suites (`-apps-security`, `-infra-security`) are enabled by default but are
not the release security archive, so they do not satisfy the check. A missing origin only prints a warning naming
`50unattended-upgrades`: an administrator policy is reported, never rewritten,
following ADR 0031's ownership rule.

No generic multi-distribution abstraction, package-manager layer or
distribution detection library is introduced. The table, one repository-path
helper and one rendering function are the whole change.

## Consequences and limits

- The installer now names three distribution/release targets to validate on
  real systems; the disposable-VM checklist in
  [installation](../installation.md#verification-before-release) gains Debian
  rows and stays *pending* until each row is recorded.
- Debian 12 moves to oldstable: the row is removed when Docker stops
  publishing `bookworm` packages, not beforehand.
- Debian derivatives (Kali, Raspberry Pi OS, Ubuntu-based images) stay
  refused, even when their `/etc/os-release` reports a close derivative: the
  codename check is deliberate.
- The security-origin check reads the effective APT configuration. It cannot
  prove that updates are actually installed, only that the configured origins
  include this release's security archive.
- `--check` remains read-only: the new check calls `apt-config dump` only.

## Validation

Unit fixtures cover the supported-host table, the rendered Docker repository
file for both families and the security-origin classifier, on both the Ubuntu
CI runner and a Debian container. Real compatibility (APT, systemd, TLS and
firewall behavior) still requires disposable Debian VMs, including reruns,
interrupted runs and reboots, as recorded in
[installation](../installation.md#verification-before-release).
