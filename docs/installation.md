# Install on Ubuntu Server

The interactive installer targets **Ubuntu Server 24.04 LTS and 26.04 LTS**,
on **amd64 and arm64**, with systemd. It is intended for a fresh VPS.
No Bun installation or image build is needed on the server.

```sh
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/lekoala/compose-panel.git
cd compose-panel
sudo bash scripts/install.sh --check
sudo bash scripts/install.sh
```

Keep this checkout at its original location: the panel's Compose labels and
self-updater refer to its absolute path. Use a path without spaces. Because
root runs scripts from it, the installer refuses a checkout whose scripts,
deployment files or parent directories another user could change: they must
belong to root or to the user running `sudo`, without group or other write
access except for a private user group with no other member (Ubuntu's usual
umask 002). Sticky directories such as `/tmp` are accepted as parents.
Use `sudo bash` as shown above; a root shell without `SUDO_UID` requires a
root-owned checkout. The checks inspect Unix modes and group membership, not
named POSIX ACL entries: do not grant other users write access through ACLs.
`ss` (`iproute2`) and `getent` (`libc-bin`) must be available for preflight.

The script first checks the server and shows a plan for this host: what is
already present and kept, and what will be installed. It requires `yes` before
changing anything. Then it asks for a unique administrator username and a
password of at least 12 characters, and optionally a domain with a separate
HTTPS password. Invalid answers are asked again; password prompts do not echo.
`--install` is equivalent to the default; `--yes` skips the plan confirmation,
but the first installation still requires a terminal for credentials.
`--check` inspects the host without downloading packages or writing files; it
does not prove that package repositories, registry, DNS or TLS are available.
Existing repository files at the expected paths are compared with downloads
during installation; their content is not verified by `--check`.

Installation runs in seven numbered steps. Package, image and helper output
goes to `/var/log/compose-panel-install.log` (root only, replaced on each run,
never containing passwords); on failure, its last lines are shown. The final
summary gives the SSH tunnel command, the HTTPS address when verified, and
where settings and the log are.

## What is installed

- Missing Docker Engine, CLI, containerd, Buildx and Compose plugin from
  [Docker's official Ubuntu APT repository](https://docs.docker.com/engine/install/ubuntu/).
  Existing working Docker CE is reused without a requested restart or upgrade.
  Distribution Docker, the Docker snap (offered by the Ubuntu Server
  installer), rootless Docker and incomplete installations are refused.
- Missing Caddy from its
  [official stable package repository](https://caddyserver.com/docs/install#debian-ubuntu-raspbian),
  as the host systemd service. The generated Caddyfile uses `basic_auth`,
  which needs Caddy 2.8 or later; the official repository provides it.
- Ubuntu's `unattended-upgrades`, if absent, with daily package-list refresh and
  unattended upgrades, and automatic reboots disabled. Its APT timers are
  enabled on every run while that exact policy is in place. An existing
  installation keeps its policy; review any warning that its upgrade timer is
  disabled.
- `/opt/stacks`, if absent, and the panel from
  `ghcr.io/lekoala/compose-panel:latest`, through `deploy/compose.prod.yaml`.
- The Caddy helper using `setup-caddy.sh --install --yes --production`,
  compiled from the image the panel actually runs. The helper socket is tested
  from inside the container before success is reported.

Packages already present are never upgraded (`apt-get install --no-upgrade`).
An existing Docker or Caddy service that is not enabled at boot is reported,
not changed.

Trust is based on HTTPS downloads and APT signatures: the Docker and Caddy
repository keys are fetched over TLS without a pinned fingerprint, and the
first panel image is the `latest` tag as served by GHCR. Its digest is not yet
compared with `releases.json`; later updates through About do check it.

The installer never removes conflicting packages, adds users to the Docker
group, modifies SSH or firewall rules, or reboots. Review the plan as root:
the panel's Docker socket access grants control equivalent to root.
There are no new application dependencies.

## Private access (default)

Leave the domain empty. The panel listens only on `127.0.0.1:5081`, with host
networking and no published port. On your workstation:

```sh
ssh -L5081:127.0.0.1:5081 you@server
```

Then visit `http://127.0.0.1:5081`. Keep your server's actual SSH port reachable
(usually TCP 22). Caddy and its helper are still installed, ready for
application domains you attach later.

## HTTPS access

Before installation, point the domain's A and, if present, AAAA records to the
server. Both the provider's firewall and the host must allow inbound TCP 80
and 443 for Caddy's automatic HTTPS. The installer reports UFW status and
refuses occupied Caddy ports on a new installation; it does not open ports.
Docker-published application ports may bypass UFW rules.

Enter a lowercase domain such as `panel.example.org`, without `https://` or a
path. Choose a **separate** HTTPS password when prompted. Caddy's Basic Auth
uses the same username as the panel, with that separate password; after that
browser challenge, sign into the panel with its own password. Caddy protects
all panel routes. `COMPOSE_PANEL_ALLOW_LOOPBACK=true` retains the SSH fallback.

The script checks certificate validation and HTTP 401 at both the local Caddy
listener and the public DNS name from the server. It prints the final HTTPS URL
only after these checks succeed. This confirms TLS and the authentication
challenge, not remote reachability or a successful authenticated session: verify
both login steps from your browser. If DNS or certificates are still pending,
the script exits **2**, reports HTTPS as unverified and leaves SSH access
available. Correct DNS/firewall issues and rerun.

No DNS records are created. A firewall or NAT rule outside this server cannot
be diagnosed conclusively from the host.

## Existing hosts, reruns and failures

`deploy/compose-panel.env` is root-owned and `0600`. It holds the
administrator username, the quoted Argon2id panel hash and bcrypt HTTPS hash,
the HTTPS origin if any, the loopback fallback and the Caddy helper settings.
It never holds plaintext passwords: they reach the hashers through stdin only,
never process arguments or Docker container environment. The extra
`COMPOSE_PANEL_INSTALLER_PROXY_HASH` setting is used by the installer; like
other `COMPOSE_PANEL_*` settings it is removed from stack subprocesses.
`/etc/caddy/Caddyfile` repeats the bcrypt hash, so it is `root:caddy`, `0640`.
A rerun corrects older permissions without changing its content. Backups
`Caddyfile.bak-setup.*` matching that configuration become `root:root`, `0600`.
Other backups with publicly readable bcrypt hashes are reported for manual
review; their content and permissions are left intact. Restrict or remove
them after review, since they may contain earlier credentials.

**Do not edit `compose-panel.env` or the Caddyfile by hand on an installer
deployment.** A rerun compares both byte for byte with what it would write,
and refuses to continue when they differ. To customize them, switch to the
[manual deployment](deployment.md) procedure.

A repeat invocation preserves the credentials, access configuration, stack
directory contents and running panel image. It verifies the exact project,
service, working directory and Compose-file labels. The helper is rebuilt and
the panel may be recreated on the **same running image**; sessions are then
lost. Installation is not a panel upgrade mechanism. A stopped panel container
(for example after a first run whose health wait expired) is started again as
is; a running but unhealthy one is reported, not recreated: inspect its logs.

An existing foreign Caddyfile, foreign environment file, changed installer
settings, project/container collision, implicit `deploy/.env`, symbolic link
or incompatible helper unit causes refusal. The installer does not adopt or
rewrite that configuration. Use the [manual deployment](deployment.md) and
`setup-caddy.sh` for customized hosts. Existing application domain files under
`/etc/caddy/compose-panel.d` are preserved.

On a new Caddy installation, the packaged Caddyfile is backed up as
`/etc/caddy/Caddyfile.bak-setup.*`. The replacement is validated as the Caddy
user before reload. Validation/reload failure restores the original; a failed
rollback reload requires host intervention. Changed helper binaries are backed
up as `/usr/local/bin/compose-panel-caddy-helper.bak-*`.

Package installation and deployment are **not one transaction**. Network/APT
failure, interrupted execution or an unhealthy container leaves completed
steps in place; no packages, containers, volumes or stacks are removed.
A failure between installing Caddy and writing the owned Caddyfile (registry
pull, unhealthy panel) leaves the packaged Caddyfile. A rerun resumes only if
that file is byte-identical to the one shipped by the `caddy` package (dpkg
checksum) and no application routes exist yet; any edited Caddyfile is refused.
Docker and Caddy repository files left by an interrupted run are reused only
when byte-identical to the fresh download, and only if no other APT source
refers to that repository. A helper binary installed without its systemd units
is rebuilt and completed by the rerun.
Matching repository files have their ownership and mode restored to
`root:root`, `0644`, so `_apt` can read them. A legitimate repository-key
rotation also causes a byte mismatch: verify the new key through the
vendor's official installation instructions and complete the repository
configuration manually before rerunning. The installer never silently
replaces a differing key.

Some states remain manual: an installed Caddy that is not running, a stopped
Docker daemon, or a partly installed package. Inspect and finish through the
manual procedure rather than deleting files blindly. Interruption by Ctrl-C,
`TERM` or a closed SSH session (`HUP`) runs the Caddy rollback and releases its
lock; `SIGKILL` or a power loss does not. The installer does not claim
automatic crash recovery.
If installation stopped after installing `unattended-upgrades` but before
writing the installer policy, its existing policy is kept; inspect the
reported timer and APT settings rather than assuming our policy was applied.

Read-only diagnostics of the whole installation (Docker, panel identity and
health, Caddy, helper, settings permissions, HTTPS origins):

```sh
sudo bash scripts/doctor.sh --production
```

It changes nothing. Exit code 0 means every check passed, 1 a failure, 2 that
external HTTPS is still unverified. On an installer deployment, an HTTPS origin
answering without the Basic Auth challenge counts as a failure. Runtime sandbox
validation of Caddy is only done by `setup-caddy.sh --install`. Other useful
commands:

```sh
sudo docker inspect -f '{{.State.Health.Status}}' compose-panel
sudo systemctl status caddy caddy-helper.socket
sudo journalctl -u caddy --since '10 minutes ago'
sudo bash scripts/setup-caddy.sh --check --production
```

Docker logs may contain sensitive data; inspect them locally and redact before
sharing; `doctor.sh` never prints them.

## Updates and removal

Use **About → Update** for controlled panel updates. After an image update,
rebuild the helper from the running image:

```sh
sudo bash scripts/setup-caddy.sh --install --production
```

When following the manual update/rollback commands in `deployment.md`, use
`deploy/compose.prod.yaml` wherever the examples use `deploy/compose.yaml`.
The source-build deployment remains available in `deploy/compose.yaml`.

To remove only the panel, from the original checkout:

```sh
sudo docker compose -p compose-panel -f deploy/compose.prod.yaml down
```

Stack containers and files are kept. Caddy, the helper, APT repositories and
security-update policy remain installed; remove or change those manually after
reviewing the application domains that use them.

## Verification before release

Automated tests use temporary files and fake Docker/systemd/Caddy executables.
They exercise credentials, exact identities, refusal paths, file modes,
no-clobber publication and rollback, without touching a host daemon.
CI also runs ShellCheck and real Compose configuration parsing with no daemon
access. They do not establish that APT, systemd or public TLS work on a real VPS.
The complete preflight runs against fixture host trees with fake host
commands: each scenario asserts that files and metadata are unchanged and that
`--check` calls no mutating command. Installer signal cleanup is not yet
covered by an end-to-end automated fixture; the VM checks below cover it.

Local verification on 2026-10-20 used a disposable Debian arm64 container in
Docker Desktop on macOS, Bun 1.4.3, no host mounts and no Docker socket:

- `bun run test` as an unprivileged user: 847 passed, 25 skipped, none failed.
  This included five real Caddy 2.8.4 integration tests with temporary
  configuration, certificates and ports.
- Opt-in Compose configuration tests with CLI 29.9.0 and Compose 5.6.0:
  four passed, without a daemon.
- Filesystem/editor/stack-creation tests as container root: 58 passed,
  including ownership checks skipped by the unprivileged run.
- Typechecking, ShellCheck, Bash syntax and documentation build passed.

These checks do not run an Ubuntu installation or boot systemd. Direct writes
of helper units and appended manual-deployment settings in `setup-caddy.sh`
also remain candidates for atomic publication.

The following **manual checks remain required** in disposable systemd VMs:

| Ubuntu | Architecture | Fresh private install | HTTPS + two logins | Rerun + reboot |
| --- | --- | --- | --- | --- |
| 24.04 | amd64 | Pending | Pending | Pending |
| 24.04 | arm64 | Pending | Pending | Pending |
| 26.04 | amd64 | Pending | Pending | Pending |
| 26.04 | arm64 | Pending | Pending | Pending |

For each VM:

1. Run `--check`; compare system files and confirm no writes. Install privately,
   sign in through SSH and check container health and the helper status.
2. On a separate fresh snapshot, use a public test domain. Check both passwords,
   valid TLS, Secure session cookies, the SSH fallback and no public port 5081.
3. Attach a disposable application's domain through the panel, rerun the
   installer and reboot. Verify unchanged env bytes, app/domain content,
   healthy panel, helper socket and the same application containers.
4. Cache a newer panel image tag without updating the running container. Rerun:
   the panel keeps the old running image and the cached tag is restored.
5. Test conflicting Docker packages, occupied ports, foreign Caddyfile,
   foreign same-name/project containers, env symlinks and parent-directory
   symlinks. Check refusal before package/file/resource mutation.
6. Interrupt APT/pull, fail Caddy validation/reload, and make the panel unhealthy.
   Confirm a nonzero result, retained backups and no destructive cleanup.
7. Update the panel through About when eligible, rebuild the helper, then test
   the documented rollback with `compose.prod.yaml`.

Never run these mutation scenarios against production Docker resources.
