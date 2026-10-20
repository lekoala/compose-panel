# ADR 0031 — One-time Ubuntu host installation

Status: accepted

## Context

A fresh VPS currently needs several manual deployment steps: Docker, Caddy,
settings, the panel and the ADR 0030 Caddy helper. The application itself must
not become a host administration service, so this has to stay a one-time,
root-run provisioning step outside the panel.

## Decision

### Scope

Add `scripts/install.sh`, a root-run, interactive Bash installer for Ubuntu
Server 24.04 and 26.04, amd64 and arm64, with systemd and one local rootful
Docker Engine. Any other host is refused.

- `--check` only inspects: no download, no file written.
- The default (same as `--install`) shows a plan and requires typing `yes`.
- `--yes` skips that confirmation. It never supplies credentials: a first
  installation always needs a terminal.

This is a one-time provisioning exception to the roadmap's exclusion of host
package and repository management, not a new application capability.

Root sources and runs files from the checkout, so the installer first refuses
a checkout whose scripts, deployment files or parent directories another user
could change (owner other than root or the sudo user, group/other write except
a private user group, non-sticky world-writable parents).

### Host packages

Install only what is missing: Docker Engine and the Compose plugin, and Caddy,
from their official signed APT repositories, plus Ubuntu's
unattended-upgrades. Packages already present are never upgraded
(`--no-upgrade`). Reuse a working Docker CE without upgrading or restarting
it; refuse distribution, snap or incomplete Docker installations. An existing
Docker or Caddy service not enabled at boot is reported, not changed. Never
remove conflicting packages, change SSH or firewall rules, add users to the
`docker` group, or reboot. An existing unattended-upgrades policy is
preserved; the installer's own policy has its timers enabled on every run.
Ownership of that policy is determined by exact content, not its filename.
Existing Caddy must identify itself as a stable version 2.8 or later.

Repository keys are fetched over TLS without a pinned fingerprint, and the
first image is the GHCR `latest` tag; comparing its digest with
`releases.json` is left to a later decision.

### Panel deployment and access

Deploy `deploy/compose.prod.yaml` with the official image, without building on
the VPS. `deploy/compose.yaml` stays the source-build file. Project identity,
the `env_file` and same-path mounts stay explicit; port 5081 is never published.

Private SSH access is the default. Optional HTTPS uses a host Caddy site with
automatic TLS and Basic Auth, with a password separate from the panel's, and
keeps `COMPOSE_PANEL_ALLOW_LOOPBACK=true` as the SSH fallback. Passwords reach
the hashers on stdin only, never in command arguments or container
environment; `deploy/compose-panel.env` holds quoted hashes and non-secret
settings, root-owned, mode 0600. The Caddyfile, which repeats the Basic Auth
hash, is `root:caddy` 0640, including after reruns of an older installation.
Matching backups are restricted to `root:root` 0600; foreign backups exposing
bcrypt hashes are reported for manual review.

The installer then runs `setup-caddy.sh --install --yes --production`.
`--production` explicitly selects `compose.prod.yaml`; the helper still
verifies the exact Compose labels of the running panel.

### Existing hosts and reruns

Before any change, refuse foreign deployment files, project or container
collisions, implicit `deploy/.env`, symbolic links, differing helper units and
foreign Caddy configurations. Nothing found is adopted or rewritten.

A rerun recognizes its own result byte for byte (settings and Caddyfile), and
preserves credentials, access settings and the running image. It is not an
upgrade mechanism: updates go through About → Update.

The only Caddyfile the installer replaces is the default one shipped by the
`caddy` package: on a new Caddy installation, or on a rerun after an earlier
failure left it in place. It must be unmodified (its dpkg conffile checksum)
and no application routes may exist yet. Existing application domain files
are kept. Likewise, APT repository files left by an interrupted run are reused
only when byte-identical to the fresh download and when no other source refers
to that repository; a helper binary without its units is rebuilt.
Matching repository files have their metadata normalized to `root:root` 0644.
Key rotations remain a manual review: a changed download never overwrites an
existing key automatically. Any repository-search error refuses adoption.

### Reliability of Caddy changes

The installer and `setup-caddy.sh` take the same host lock as panel
attach/detach (`with-caddy-lock.sh` protocol) for publication, validation,
reload and rollback. A separate lock prevents two installers from running
together; an installation takes it before its checks, so a plan cannot be
applied after another installer changed the host. `--check` takes no lock.
It does not exclude `setup-caddy.sh` or manual changes during the prompts.

- The Caddyfile and helper binary are replaced by atomic rename on the same
  filesystem, after a backup.
- The candidate is validated as the `caddy` user and inside the helper's
  systemd sandbox; a sandbox validation failure is a setup failure.
- On validation or reload failure the backup is restored and reloaded. A
  restored file whose reload fails is reported as an unknown running
  configuration, never as success.
- On interruption (INT, TERM, or HUP from a closed SSH session), EXIT cleanup
  attempts the rollback before releasing the lock. SIGKILL still needs a
  manual inspection.
- Docker runs, hashing and systemd calls are bounded by timeouts.

Package installation and deployment are not transactional: a failure leaves
completed steps in place and never removes stacks, containers or packages.
Exit codes: 0 success, 1 failure, 2 installed but external HTTPS unverified.

### Read-only diagnostics

Add `scripts/doctor.sh [--production]` to check an installation without
changing it: local Docker and Compose, exact panel identity, container health,
helper mount and status, services enabled at boot, settings permissions and
configured HTTPS origins. Installer HTTPS deployments also check Caddyfile
and bcrypt-bearing backup permissions. Container inspection errors and invalid
ports fail diagnostics rather than falling back to a healthy default.
It never pulls, deploys, reloads, repairs or starts
transient systemd units. It parses the Caddyfile with `caddy adapt` rather
than `validate`, which can provision storage, so runtime sandbox readiness
remains a check of `setup-caddy.sh --install`. Exit codes match the installer:
0 checked services passed, 1 failure, 2 HTTPS unverified.

## Consequences and limits

- One supported host family; Debian or other releases need a new decision.
- The checkout must stay at its original path: Compose labels and the
  self-updater refer to it.
- An HTTPS check from the server proves TLS and the Basic Auth challenge from
  this host only, not access from every client or an authenticated login.
- A customized host is never repaired by the installer; it uses the manual
  deployment procedure and `setup-caddy.sh`.

## Validation

ShellCheck and isolated Bash fixtures in Linux CI, with fake
Docker/systemd/Caddy/dpkg executables, plus the normal quality gates. No host
Docker mutation in automated tests. Fixtures cannot establish VPS
compatibility: real APT, systemd and TLS behavior requires disposable Ubuntu
VMs on both releases and architectures, including reruns, interrupted runs and
incompatible existing services, reported separately in
[installation](../installation.md#verification-before-release).
