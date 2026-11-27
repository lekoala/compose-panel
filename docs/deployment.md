# Deployment — single Linux host

One panel container, one Docker Engine, one administrator. The panel never
owns your stacks: Compose files on disk and Docker itself stay the sources of
truth, so removing the panel never stops your services. For sign-in, stack or
log problems, see [troubleshooting.md](troubleshooting.md).

For a fresh Debian 12/13 or Ubuntu Server 24.04/26.04, see the
[interactive installer](installation.md). It uses `deploy/compose.prod.yaml`
with the official image. In the manual commands below, substitute that file
for `deploy/compose.yaml` when maintaining an installer deployment, and pass
`--production` to `scripts/setup-caddy.sh`.

## Prerequisites

- Linux host with Docker Engine + Compose v2 and the stacks directory
  (e.g. `/opt/stacks`) already managed by `docker compose`.
- Docker to build or pull the image. No Bun install is needed on the host: the
  image runs `hash-password` for you below. Bun 1.4.5+ is only needed to build
  the image (pinned in CI and the Dockerfile).
- A unique admin username (`COMPOSE_PANEL_ADMIN_USER`): common names
  (`admin`, `root`, …) are refused at startup unless `COMPOSE_PANEL_DEV=true`.

## Deploy

Build or pull the image **before** generating the hash, so the image can
generate it for you:

```sh
# 1. Copy the settings and build (or pull) the image
cp deploy/compose-panel.env.example deploy/compose-panel.env
docker compose -f deploy/compose.yaml build

# 2. Generate the admin password hash with the image itself
read -rsp "Compose Panel password: " COMPOSE_PANEL_PASSWORD; echo
export COMPOSE_PANEL_PASSWORD
docker run --rm --entrypoint bun -e COMPOSE_PANEL_PASSWORD \
  compose-panel:local src/scripts/hash-password.ts
unset COMPOSE_PANEL_PASSWORD

# 3. Paste the hash, single-quoted, and a unique username into
#    deploy/compose-panel.env, then lock the file down and start
chmod 600 deploy/compose-panel.env
docker compose -f deploy/compose.yaml up -d
curl -fsS http://127.0.0.1:5081/health/live  # -> ok
```

The hash must be **single-quoted** in `compose-panel.env`: Docker Compose
applies variable interpolation to unquoted and double-quoted `env_file` values,
so a `$` in the Argon2id hash would be expanded and the panel would reject the
password. On a machine that already has Bun you can instead run
`COMPOSE_PANEL_PASSWORD='...' bun run hash-password`.

The example is deliberately minimal. Caddy integration, path aliases and every
advanced override are documented in [configuration.md](configuration.md); do
not copy the tuning table into `compose-panel.env`.

Rules that must stay true:

- **Host path == container path** for stacks (`/opt/stacks:/opt/stacks` plus
  matching `STACKS_DIR`) and the socket. Otherwise `compose ls` ConfigFiles
  no longer match and stacks report `unknown`.
- **`stop_grace_period` (35s) must exceed `COMPOSE_PANEL_SHUTDOWN_GRACE_MS`**
  (default 30s) so `SIGTERM` drains running operations instead of killing them.
- The panel binds **127.0.0.1 only** (hard-coded). With host networking that
  is the host loopback. Remote access goes through an SSH tunnel
  (`ssh -L5081:127.0.0.1:5081 you@host`) or through Caddy on the same host
  (next section). Never add a `ports:` mapping: there is nothing to publish.
- Sessions live in memory: every panel restart logs the admin out. No session
  persistence is needed or provided.
- Mounting `/var/run/docker.sock` gives whoever can edit Compose files very
  high control over the host (see `docs/security.md`). Trusted admin only.
- Panel settings must stay in the `COMPOSE_PANEL_*` namespace. Compose
  subprocesses get the process environment with that namespace stripped
  ([ADR 0008](adr/0008-compose-subprocess-environment.md)), so panel secrets
  never reach a stack. Other variables (e.g. `COMPOSE_PROJECT_NAME`,
  `DOCKER_HOST`) pass through by design.

## Private registries

The panel never stores or displays registry credentials. Its Docker CLI reads
the usual client configuration (`$DOCKER_CONFIG`, default `$HOME/.docker`), which
is **empty inside the container**: mounting `/var/run/docker.sock` gives access
to the daemon, not to the credentials configured on the host. Public images work
as they are. On a private registry without credentials, `Pull` fails with an
authentication error and the operation is reported as failed — nothing is
downloaded and nothing claims the image is current. **Check** reports such a
registry as an unknown result (`unauthorized`) instead.

To let **Pull** and the remote **Check** reach a private registry, mount a
dedicated configuration file read-only and point the panel at it. ADR 0041
verified this path end to end: without it the registry returns 401, with it the
same command authenticates, and Pull and the check share one configuration.

Buildx, which reads the registry for **Check**, keeps its own state and lock in
`$BUILDX_CONFIG` (default `$DOCKER_CONFIG/buildx`) and writes there **before**
contacting the registry. A read-only `DOCKER_CONFIG` mount is therefore not
enough on its own: without a writable `BUILDX_CONFIG`, Pull can work while Check
fails despite valid credentials. Set `BUILDX_CONFIG` to a writable directory, or
leave it unset: the panel then uses a panel-owned ephemeral directory under the
system temp dir. It never writes to `DOCKER_CONFIG`.

```yaml
services:
  panel:
    environment:
      DOCKER_CONFIG: /etc/compose-panel/docker-config
      BUILDX_CONFIG: /tmp/compose-panel-buildx
    volumes:
      - /etc/compose-panel/docker-config:/etc/compose-panel/docker-config:ro
```

The service is `panel` in both `deploy/compose.yaml` and
`deploy/compose.prod.yaml`. Keep the file outside `/run` (a tmpfs that is cleared
on reboot) and outside `$HOME`, so it survives a restart and cannot be picked up
by another tool: `/etc/compose-panel/docker-config/config.json` holds only what is
needed, with a token that has the narrowest possible scope (read-only package
access is enough for pulls):

```json
{ "auths": { "ghcr.io": { "auth": "<base64 user:token>" } } }
```

Keep the file `0600` and owned by root, and never reuse it for anything else.
Credential helpers (`credsStore`) are not installed in the image and produce an
unknown result, so use `auths` entries. The panel never reads, logs or renders
the file: it only passes the environment to the Docker CLI it already runs.

## Upgrading from 0.1.0

0.2.0 replaces the single `COMPOSE_PANEL_PUBLIC_ORIGIN` with the list
`COMPOSE_PANEL_PROXY_ORIGINS`, and removes `COMPOSE_PANEL_TRUST_PROXY` (the
forwarded address is now trusted per matched origin automatically). Both old
settings are refused at startup with a migration message — the panel never
reinterprets security configuration silently ([ADR 0012](adr/0012-multiple-access-origins.md)).

```sh
# 0.1.0
COMPOSE_PANEL_PUBLIC_ORIGIN=https://panel.example.com
COMPOSE_PANEL_TRUST_PROXY=true

# 0.2.0 — reverse proxy only
COMPOSE_PANEL_PROXY_ORIGINS=https://panel.example.com
# 0.2.0 — HTTPS and the SSH tunnel together
COMPOSE_PANEL_PROXY_ORIGINS=https://panel.example.com
COMPOSE_PANEL_ALLOW_LOOPBACK=true
```

A single origin behaves as before. The change is that the SSH tunnel and HTTPS
no longer exclude each other, and several origins can be listed.

## Behind Caddy (HTTPS)

To use the panel from a browser without a tunnel, put Caddy in front of it on
the **same host** ([ADR 0010](adr/0010-reverse-proxy-mode.md)). The panel stays
bound to `127.0.0.1`, so Caddy must reach the host loopback: run it on the host
itself, or in a container with `network_mode: host`.

> **Version note.** The list setting below (`COMPOSE_PANEL_PROXY_ORIGINS`) is the
> 0.2.0 contract ([ADR 0012](adr/0012-multiple-access-origins.md)). On 0.1.0 the
> equivalent is the single `COMPOSE_PANEL_PUBLIC_ORIGIN=https://…`; see
> [Upgrading from 0.1.0](#upgrading-from-010).

1. In `deploy/compose-panel.env`, list the origins. This setting allows HTTPS
   access and makes Secure cookies and Caddy's `X-Forwarded-For` apply on those
   hosts:

   ```sh
   COMPOSE_PANEL_PROXY_ORIGINS=https://panel.example.com
   ```

   Each entry must be `https` (outside `COMPOSE_PANEL_DEV=true`), with no
   credentials, path, query or fragment, no empty entry and no duplicates.
   Several origins are comma-separated:

   ```sh
   # A public domain and a private overlay name, for example
   COMPOSE_PANEL_PROXY_ORIGINS=https://dockge.example.com,https://<machine>.<tailnet>.ts.net
   ```

   With no origin listed, the SSH tunnel is the only path. To keep using the
   tunnel *and* the proxy, opt in explicitly:

   ```sh
   COMPOSE_PANEL_ALLOW_LOOPBACK=true
   ```

   Upgrading from 0.1.0: `COMPOSE_PANEL_PUBLIC_ORIGIN` is refused at startup —
   rename it to `COMPOSE_PANEL_PROXY_ORIGINS`, and remove any
   `COMPOSE_PANEL_TRUST_PROXY` (forwarded headers now follow the matched origin
   automatically). See [ADR 0012](adr/0012-multiple-access-origins.md).

2. Add a site to Caddy. Caddy obtains the certificate, redirects HTTP to HTTPS
   and streams the live output without extra settings:

   ```caddyfile
   panel.example.com {
   	reverse_proxy 127.0.0.1:5081
   }
   ```

   With caddy-docker-proxy (labels), the Caddy container must use
   `network_mode: host` for `127.0.0.1` to mean the host. Then add to the
   panel service in `deploy/compose.yaml`:

   ```yaml
   labels:
     caddy: panel.example.com
     caddy.reverse_proxy: 127.0.0.1:5081
   ```

   A Caddy container on a bridge network cannot reach the panel. That is
   deliberate: the bind is not configurable.

3. Restart the panel and check that it says `Reverse proxy mode: origins
   https://panel.example.com; ...` at startup. Sign in through the public URL.
   With `COMPOSE_PANEL_ALLOW_LOOPBACK=true`, the SSH tunnel
   (`ssh -L5081:127.0.0.1:5081 you@host`) keeps working alongside it: each path
   is validated on its own — a form built for the proxy origin is refused when
   posted through the tunnel and the reverse — and only the HTTPS path sets
   Secure cookies.

   With several proxy origins, Caddy serves each name and forwards to the same
   panel; no second panel is needed:

    ```caddyfile
    dockge.example.com {
    	reverse_proxy 127.0.0.1:5081
    }
    # Replace this placeholder with the exact HTTPS URL returned by
    # `tailscale serve status`:
    <machine>.<tailnet>.ts.net {
    	reverse_proxy 127.0.0.1:5081
    }
    ```

**Add a second barrier.** The panel controls Docker, i.e. the host, and one
password protects it. In order of preference:

- keep it off the public internet: Tailscale or WireGuard, and a Caddy site
  bound to that interface;
- restrict sources in Caddy:

   ```caddyfile
   panel.example.com {
   	# Replace TEST-NET-3 with your actual trusted client CIDR.
   	@outside not remote_ip 203.0.113.0/24
   	respond @outside 403
   	reverse_proxy 127.0.0.1:5081
   }
   ```

- or add Caddy `basic_auth` in front of the panel's own sign-in;
- and in every case, ban repeated failures at the host from the activity log
  (see [Host-level ban](#host-level-ban-fail2ban--crowdsec)).

Only Caddy is tested (`bun run test:proxy:wsl`, or
`bash scripts/proxy-e2e/run.sh` on Linux: a real Caddy with TLS in front of the
working tree, with a fake `docker` that never touches a daemon). Other proxies
need explicit SSE flushing and correct `X-Forwarded-For` handling, and are not
covered.

**Review what is configured.** Once signed in, the read-only `Access & security`
page (`/access`) lists the loopback path and every proxy origin with an honest
status ([ADR 0013](adr/0013-access-diagnostics.md)): what the panel verified
itself, what is configured but unverified (a proxy origin's network restriction),
and what only you can check (whether a tunnel is open, whether a firewall or VPN
really restricts access). It never marks an access secure from its configuration
alone.

## Private access (Tailscale Serve)

If the panel does not need to be reachable from the internet, expose it only on
a private network. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
publishes a local service over HTTPS to the members of your tailnet, with no
public port and no Caddy:

```sh
# On the host, after `tailscale up` (with MagicDNS and HTTPS enabled):
tailscale serve --bg --https=443 http://127.0.0.1:5081
tailscale serve status   # prints https://<host>.<tailnet>.ts.net
```

Then list that `ts.net` origin and keep the SSH tunnel as a fallback (0.2.0):

```sh
# Replace this placeholder with the exact HTTPS URL returned by
# `tailscale serve status`:
COMPOSE_PANEL_PROXY_ORIGINS=https://<machine>.<tailnet>.ts.net
COMPOSE_PANEL_ALLOW_LOOPBACK=true
```

Use `tailscale serve`, never `tailscale funnel`: Funnel would publish the panel
to the public internet. Tailscale is only an access path here — the panel keeps
its own password, so it stays optional and is never a dependency. A Caddy site
bound to the private interface, or an IP allow-list in front of a public Caddy
site, are equally valid alternatives; use whichever your network already has.

## Behind Cloudflare Access + Tunnel (identity proxy)

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
publishes the panel without opening an inbound port, and
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
checks an identity before the request reaches it. The panel is not modified and
does not know Cloudflare: `cloudflared` is just another reverse proxy on the
same host, reaching the loopback listener, so the rules above apply unchanged.

1. Install `cloudflared` on the host and point the tunnel's origin at the panel.
   With a locally-managed tunnel:

   ```yaml
   # ~/.cloudflared/config.yml
   tunnel: <tunnel-id>
   ingress:
     - hostname: panel-cf.example.com
       service: http://127.0.0.1:5081
     - service: http_status:404
   ```

2. List the tunnel hostname as a proxy origin, exactly as for Caddy. If it sits
   next to an existing Caddy site and the SSH tunnel:

   ```sh
   COMPOSE_PANEL_PROXY_ORIGINS=https://dockge.example.com,https://panel-cf.example.com
   COMPOSE_PANEL_ALLOW_LOOPBACK=true
   ```

   The panel keeps its own sign-in, sessions and CSRF; facing the same origin
   with two proxies (for example Caddy and the tunnel) needs no extra setting.

3. **Create and verify the Access policy before publishing the route.** A
   Cloudflare Tunnel route with no protecting Access application is reachable
   publicly, and protecting the hostname does nothing if another network path
   to the panel bypasses Access. Enable *Protect with Access* on the tunnel so
   `cloudflared` validates the access token itself, restrict the policy to the
   identities that may use the panel, and keep the SSH tunnel as a fallback for
   when Cloudflare is unreachable.

Notes on the trust chain:

- The panel authorizes on its own password and CSRF token only. It never treats
  a request as authorized because it carries a Cloudflare or identity header.
- Only the **last** `X-Forwarded-For` entry is read — the one the local proxy
  (`cloudflared`) appended. Vendor identity headers such as `CF-Connecting-IP`
  are ignored. Do not read them in the panel's name elsewhere.
- Placing Cloudflare **in front of Caddy** (instead of tunnelling straight to
  the panel) makes the last `X-Forwarded-For` entry Caddy's connecting address,
  i.e. a Cloudflare edge address, not the visitor. If you need the real client
  address in the audit log, terminate at the panel with one trusted proxy.

This path is documented, not covered by the end-to-end test (only Caddy is
tested). Verify it on your own host before relying on it.

## Optional Caddy site management

Stacks that serve HTTP on the host loopback can get a public domain without
leaving the panel ([ADR 0030](adr/0030-optional-caddy-sites.md)): a Domains
section on the stack page attaches `app.example.com` to a service's
loopback-bound port, publishes one managed file per domain, and reloads Caddy.
The panel never edits your main `Caddyfile` and never touches sites it did
not create. DNS and HTTPS are not checked by the panel: after attaching, open
the application link and verify reachability yourself.

The integration is opt-in and in two parts: a preview that needs nothing, and
real attach/detach through a small privileged helper on the host. Without the
helper, Domains stays a preview (the managed file is shown, nothing is
written or reloaded).

### Setup with the script

Supported layout: Caddy installed on the host as the systemd service `caddy`
running `/etc/caddy/Caddyfile` (the official package), and the panel deployed
with `deploy/compose.yaml`. A Caddy that runs in a Docker container is not
supported by the helper: the script refuses it instead of half-installing.

From the Compose Panel checkout on the host:

```sh
sudo bash scripts/setup-caddy.sh --check     # read-only: checks and the planned changes
sudo bash scripts/setup-caddy.sh --install   # applies them after you type "yes"
```

`--check` changes nothing: it verifies the host (Linux, systemd, root, host
Caddy service and its `Caddyfile`, the `caddy` user, administration API not
disabled, the panel container and its `/run/compose-panel` mount) and lists
what `--install` would do. Any failed check stops both modes before a single
change. `--install` then, each step idempotent (a second run changes nothing):

The container must belong to project `compose-panel`, service `panel`, with
this checkout's `deploy` working directory and only `deploy/compose.yaml` in
its Compose labels. One-off containers, extra Compose/interpolation files and
an implicit `deploy/.env` are refused. The configured image reference must
match the running container's reference and still exist locally.

1. creates `/etc/caddy/compose-panel.d` owned by `caddy`;
2. compiles the helper **from the panel image that is running**, offline
   (`docker run --network none … bun build --compile`): same version as the
   panel, host architecture, no Bun on the host and no extra download;
   installs it to `/usr/local/bin/compose-panel-caddy-helper`;
3. installs and enables the systemd socket and service units;
4. appends `import /etc/caddy/compose-panel.d/*.caddy` to the `Caddyfile`
   after a timestamped backup, validates as the `caddy` user, then
   `systemctl reload caddy`; either failure restores the backup. An existing
   import of that directory with another pattern is refused, never rewritten.
   It also runs `caddy validate` once inside the helper's sandbox and warns if
   that fails (see "Systemd sandbox" below);
5. adds `COMPOSE_PANEL_CADDY_ENABLED=true` and
   `COMPOSE_PANEL_CADDY_SOCKET_PATH` to `deploy/compose-panel.env` after a
   backup (ignored by Git; it contains the same secrets as the original).
   Other values already set there are refused, not overwritten;
6. recreates the panel and checks it is healthy, mounts the socket directory
   and reaches the helper from inside the container. If the panel does not
   come back healthy, or Compose exits unsuccessfully, the previous
   `compose-panel.env` is restored and recreation is attempted again. A failed
   rollback is reported explicitly.

Recreation never builds or pulls, and only targets the panel service. To keep
the running version even if **About → Check** has pulled a newer image, setup
temporarily points the configured local tag at the running image ID, then
restores the previously cached tag, also on failure or a handled signal. This
preserves the container's tag reference and Compose labels for browser updates.
Do not run image pulls, updates or another setup concurrently. If another writer
changes the tag, setup refuses to overwrite that change. A crash or SIGKILL
cannot run cleanup and can leave the tag pointing at the previous image; check
Docker's actual state before retrying.

`--yes` skips the confirmation prompt, for automation. Run `--install` again
after each panel image update (including **About → Update**): it recompiles
the helper from the new image so both sides keep the same protocol.

`deploy/compose.yaml` always mounts `/run/compose-panel` read-only, so the
script never edits that versioned file; on a host without the helper it is an
empty directory.

### Manual setup

The script performs exactly these steps; they stay documented for other
layouts and for review.

1. Prepare Caddy (host operation, once). The helper owns exactly one
   directory; your main `Caddyfile` imports it:

    ```sh
    mkdir -p /etc/caddy/compose-panel.d
    chown caddy:caddy /etc/caddy/compose-panel.d
    chmod 755 /etc/caddy/compose-panel.d
    ```

    ```caddyfile
    # /etc/caddy/Caddyfile (host paths, forward slashes)
    import /etc/caddy/compose-panel.d/*.caddy
    ```

    ```sh
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
    systemctl reload caddy
    ```

    Keep Caddy's administration API enabled (the default): `caddy reload`
    uses it, and the helper refuses to work without it.

2. Build and install the helper (host operation, once per panel version).
   The panel image already contains Bun and the sources, so the host needs no
   Bun, no Node, no extra dependency — the output is a single self-contained
   binary:

    ```sh
    out=$(mktemp -d)
    docker run --rm --network none --entrypoint bun -v "$out:/out" \
      "$(docker inspect -f '{{.Image}}' compose-panel)" \
      build --compile src/scripts/caddy-helper.ts --outfile /out/compose-panel-caddy-helper
    install -m 755 "$out/compose-panel-caddy-helper" /usr/local/bin/compose-panel-caddy-helper
    cp deploy/caddy/caddy-helper.socket "deploy/caddy/caddy-helper@.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now caddy-helper.socket
    ```

    The helper runs as the `caddy` user, one process per request, with no
    resident daemon. It only ever writes `/etc/caddy/compose-panel.d` and
    only runs `caddy validate|adapt|reload` with fixed arguments — no shell,
    no other command.

3. Expose the socket to the panel. `deploy/compose.yaml` already mounts the
   socket's **directory**
   (`/run/compose-panel`, read-only, same path on both sides), not the socket
   file: restarting `caddy-helper.socket` recreates the socket, and a file
   bind mount would keep pointing at the removed one until the panel
   restarts. The socket unit creates that directory as root-only (`0750`), so
   no other host user can reach the helper; if the directory already existed
   (for example created by an earlier `docker compose up`), set it with
   `chmod 750 /run/compose-panel`. Then, in `deploy/compose-panel.env`, set:

    ```sh
    COMPOSE_PANEL_CADDY_ENABLED=true
    COMPOSE_PANEL_CADDY_SOCKET_PATH=/run/compose-panel/caddy-helper.sock
    ```

    Then `docker compose -f deploy/compose.yaml up -d --no-deps panel`. A
    socket path without the flag, or a relative path, is refused at startup.

### Behavior once enabled

- The stack page lists the domains attached to that stack, each with an
  application link (`https://…`, new tab, no opener access).
- **Attach domain** checks the service against the effective Compose config
  and the port against the TCP `127.0.0.1` bindings of its running containers
  (exactly what the managed file will dial). The helper then refuses a domain
  already routed anywhere in the current Caddy configuration (exactly or by a
  `*.` wildcard, for example in the main `Caddyfile`), publishes the managed
  file without ever overwriting one, validates the whole Caddy configuration,
  confirms the route is present, and reloads Caddy — all serialized behind a
  global Caddy lock, under the usual per-stack lock. A failed reload restores
  the previous file and reloads that; if the restore cannot be confirmed the
  outcome is reported as unknown, never as success. One attach can take up
  to about two minutes in the worst case (lock wait plus every `caddy`
  command at its timeout); the panel waits at least 150 s for it.
- **Detach** asks for an explicit confirmation, then removes the managed
  file and reloads, with the same rollback.
- Files the panel does not recognize, or managed files changed outside the
  panel, are refused rather than overwritten. A missing `import` in the main
  `Caddyfile` refuses the attach before anything is published.
- Stacks with a `stack.managed-by` label show their routing read-only: the
  label stays informational and attaching from the panel is refused as a
  workflow rule, not a security boundary.

Other tools that change Caddy on the same host (for example an external
deployment pipeline that owns its own routes) must take the same lock around
their Caddy step, or their reload can land between a panel publish and its
validation. Install the wrapper once and prefix that step with it:

```sh
install -m 755 deploy/caddy/with-caddy-lock.sh /usr/local/bin/with-caddy-lock
with-caddy-lock caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Run it on the host (not inside a container: the lock records a host PID), as
root or `caddy`. It waits up to `CADDY_LOCK_WAIT_SECONDS` (default 60) and
exits `75` without running anything if the lock stays held. Keep those tools'
files outside `/etc/caddy/compose-panel.d`: the panel refuses to attach a
domain they already route, and never touches their files.

Systemd sandbox. The helper service keeps `ProtectSystem=strict`: everything
but `/etc/caddy/compose-panel.d` is read-only to it, including Caddy's data
directory (`/var/lib/caddy`). With public ACME certificates `caddy validate`
writes nothing. With an internal CA (`tls internal`, `local_certs`), `caddy
validate` reads the CA from Caddy's storage and only writes it when it does
not exist yet — so it works once Caddy itself has run with that
configuration, and fails (attach refused, nothing published) otherwise. Do
not loosen the sandbox preventively; if the check below shows a write is
really needed, add a targeted `ReadWritePaths=` for that exact path only.

Removal without impact: detach every domain (or delete the managed files by
hand and `systemctl reload caddy`), set `COMPOSE_PANEL_CADDY_ENABLED=false`
and remove `COMPOSE_PANEL_CADDY_SOCKET_PATH`, recreate the panel, and stop
the socket (`systemctl disable --now caddy-helper.socket`). The import line
can stay in the `Caddyfile`: it matches nothing once the directory is empty. Stacks keep running and stay manageable by the
`docker compose` CLI throughout.

Manual verification (release gate, on the target host with its real Caddy):

- [ ] `scripts/setup-caddy.sh --check` reports every check and the planned
      changes without changing anything; `--install` applies them, and a
      second `--install` adds nothing (no duplicate import or setting, no new
      `Caddyfile` or `compose-panel.env` backup).
- [ ] On a disposable deployment, pull a newer panel tag without installing
      it, then run setup: the container and helper keep the previous image ID,
      the newer tag is restored, and About can still check for updates.
- [ ] From a second checkout, setup refuses before any changes. Simulate a
      failed Compose recreation on the disposable deployment: the env file
      is restored and rollback success or failure is reported accurately.
- [ ] Attach a domain to a loopback-bound service: the managed file appears
      with the exact ownership header, `caddy adapt` contains the route, and
      the application answers through Caddy.
- [ ] Re-attach the same mapping: reported unchanged, no reload.
- [ ] Attach with the `import` line removed from the main `Caddyfile`:
      refused with the actionable message, nothing published.
- [ ] Attach a port the service does not publish on loopback, a service
      outside the stack, and a domain file created by hand: all refused.
- [ ] Break the reload (for example stop Caddy's admin listener in a test
      config): the file is rolled back and the failure — never a success —
      is reported. Restore the listener afterwards.
- [ ] Detach asks for confirmation, then the file is gone and Caddy reloaded.
- [ ] Two attaches at once (two stacks): both succeed, serialized, one
      reload each.
- [ ] Attach a domain already served by the main `Caddyfile` or by another
      tool: refused, nothing published, its routing untouched.
- [ ] While `with-caddy-lock sleep 20` runs, start an attach: it completes
      only after the wrapper exits.
- [ ] Sandbox, as the service runs: `systemd-run --pipe --wait -p User=caddy
      -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes
      -p ReadWritePaths=/etc/caddy/compose-panel.d caddy validate --config
      /etc/caddy/Caddyfile --adapter caddyfile` succeeds (repeat with
      `adapt`), and a first attach of a brand-new domain reloads successfully.
- [ ] `systemctl restart caddy-helper.socket`, then the stack page still
      lists the domains (directory mount survives the socket recreation).

## Optional service rollout

The panel can replace **one explicitly declared service** with a short overlap:
start a second instance, wait for it to become healthy, let a reverse proxy
discover it, optionally drain the old instance, then stop and remove only the old
container. It is off by default and is not a general zero-downtime guarantee.
See [ADR 0035](adr/0035-optional-service-rollout.md).

### Enable it

```dotenv
COMPOSE_PANEL_ROLLOUT_ENABLED=true
# Optional: overall budget for one rollout (default 15 minutes).
# COMPOSE_PANEL_ROLLOUT_TIMEOUT_MS=900000
```

Then declare the service in its Compose labels:

```yaml
services:
  web:
    image: ghcr.io/example/app:${APP_VERSION}
    expose: ["8080"]
    restart: unless-stopped
    stop_grace_period: 30s
    healthcheck:
      test:
        - CMD-SHELL
        - test ! -f /tmp/drain && wget -q -O /dev/null http://127.0.0.1:8080/health/ready
      interval: 5s
      timeout: 3s
      retries: 1
      start_period: 20s
    labels:
      panel.rollout.enabled: "true"
      panel.rollout.timeout: "120"
      panel.rollout.settle: "5"
      panel.rollout.drain-file: "/tmp/drain"
      panel.rollout.drain-detect: "30"
      panel.rollout.drain-time: "20"
      panel.rollout.stop-timeout: "30"
      traefik.enable: "true"
      traefik.docker.network: "proxy"
      traefik.http.routers.monapp.rule: "Host(`app.example.com`)"
      traefik.http.services.monapp.loadbalancer.server.port: "8080"
    networks: [proxy]

networks:
  proxy:
    external: true
```

Requirements and refusals:

- An image-based service only; `build:` is refused in this version.
- No `container_name` and no published `ports`. `expose` is fine.
- No `deploy.replicas`/`scale` other than 1, no fixed `ipv4_address`/
  `ipv6_address`, and no `network_mode`, `ipc`, `pid` or `volumes_from` that
  shares another container.
- No other service may share this service's namespaces or volumes.
- Exactly one container for the service, in any state, and it must be running
  and healthy.
- A healthcheck is mandatory. The panel reads the effective `State.Health`, so a
  healthcheck defined in the image is accepted too.

### Application prerequisites and first activation

Before enabling rollout, check that the application can run two releases at
once:

- Sessions and durable files must be accessible to both instances. Keep session
  secrets and cookie settings compatible across releases; a shared session
  store alone does not guarantee that existing sessions survive a change.
- Check uploads, generated files and any cache used as application state.
  Container-local files disappear when the old container is removed.
- Allow enough memory, CPU and database connections for two instances, and
  ensure that startup hooks and background work tolerate the overlap.
- Use an immutable image reference for the release, such as a digest or a tag
  your release process never replaces.
- Apply schema changes using the new release's migration code before rollout,
  and keep them compatible with the old web instance and any workers still
  running. Add first; remove or rename in a later release. An App action in
  the old container executes the old release's code. The panel does not run
  migrations as part of rollout.

For the first activation, ship the drain-aware readiness endpoint, the Docker
healthcheck and the rollout labels together, including
`panel.rollout.drain-file`. Run one ordinary **Up** to put that contract on the
running container, then wait for it to be healthy. Adding the label only after
that Up leaves the old container without the contract and rollout is refused.
This initial Up can interrupt traffic.

### Drain contract

`panel.rollout.drain-file` is optional, but without it the panel cannot promise
that in-flight requests finish: it only stops the old container gracefully. With
a marker:

1. the panel runs `docker exec <old> touch <path>`;
2. the healthcheck must fail while the marker exists;
3. the proxy must remove the old instance from rotation;
4. the panel waits `drain-detect` for `unhealthy`, then `drain-time`, then stops
   the old container.

The marker must be per container, on the writable layer (for example `/tmp`), and
must not be on a shared bind mount or volume: two instances would become
unavailable together. The panel refuses a marker covered by a mount.

Changing the Compose file does not change the healthcheck of the container that
is already running. The contract must already exist on the old container,
including the `panel.rollout.drain-file` label, otherwise the panel refuses with
"run Up once". The new container created by that `Up` then carries the contract.

`panel.rollout.stop-timeout` is the only stop timeout the rollout uses: it is
passed to `docker stop --time`. `stop_grace_period` still governs
`docker compose stop`, but the rollout does not consult it. Set both to the same
value if you want identical behavior.

Size `drain-detect` for Docker's effective healthcheck interval, timeout and
retry count. The `drain-time` window starts only after Docker reports the old
instance unhealthy; it must still cover proxy propagation and the remaining
duration of requests already sent to that instance. Long uploads, exports,
WebSockets and SSE connections need an explicit interruption policy. The
example values are starting points, not a continuity guarantee.

### Proxy

The proxy must discover both instances, route only to healthy ones and stop
routing to the old one before it is stopped. The panel does not configure or
certify it. Traefik on a shared network is one supported pattern; the integration
test uses it.

**Caddy is different.** The optional Caddy site management in this panel routes
to a **published loopback port**, while a rollout refuses published ports. Those
Caddy routes are not compatible with rollout. A Caddy setup would need its own
container-discovery configuration, which is outside this integration.

In particular, Caddy's standard `dynamic a` upstreams do **not** run active
health checks: adding `health_uri` to that configuration does not make it
drain-aware. A shared Docker network and DNS refresh alone do not prove that
an unhealthy instance is excluded. See the
[Caddy dynamic upstream documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#dynamic-upstreams).
Use a discovery mechanism that actually excludes unready instances and verify
it with the deployed proxy. If the proxy checks readiness over HTTP, that
endpoint must itself fail while the drain marker exists; a marker checked only
by Docker's healthcheck is insufficient for an independent HTTP check.

### Verify before production use

On an isolated disposable Linux daemon with the intended proxy configuration:

1. Prove that a signed-in session survives an ordinary replacement after shared
   session storage is enabled.
2. Start two instances and observe requests reaching both. Mark one for drain
   and verify that new traffic stops reaching it while in-flight requests can
   finish. Restore exactly one healthy, unmarked instance before testing rollout.
3. Run a rollout under continuous authenticated traffic, including a slow
   request and a state-changing request. Check responses, session continuity,
   duplicate effects and the final image/container state.
4. Exercise a candidate that fails readiness and a failure after drainage.
   Verify preservation of the old instance before the boundary and manual
   intervention after it. Reconcile the service before retrying.

The existing disposable-daemon integration test uses Traefik. It does not
validate another proxy configuration or the application's session and schema
compatibility. Keep production validation supervised; never point automated
tests at a production daemon.

### What happens in the UI

- The Services table shows **Rollout…** only for a declared service that is
  running, and only while no other operation holds the stack lock.
- The confirmation page shows the parameters, the current image and the
  warnings. The **Download the image before the rollout** box is checked by
  default.
- The operation streams its phases like any other action: pull, start, health,
  settle, drain, stop, remove. Closing the page does not stop it.
- The activity log records `rollout` events (started, refused, succeeded,
  failed, intervention, unknown).

### Failures and recovery

- Before the first drain attempt, the panel may remove the candidate it created.
  It does so only after proving the container's full ID, its Compose project,
  service, file and working directory, a creation date after the operation
  started, and its absence from the initial snapshot. It also requires the old
  container to still be running and healthy; if the old one stopped or lost its
  health, the candidate is kept because it may be the last available instance.
  If anything is ambiguous, it removes nothing.
- From the first drain attempt onward, it removes nothing automatically. It
  reports **Intervention required** and keeps the candidate. There is no
  automatic rollback and the marker is never removed.
- An unconfirmed command is reported as **Outcome unknown** and keeps the stack
  lock. A panel crash leaves the outcome unknown; nothing is replayed.

Reconcile on the host:

```bash
docker compose -p <project> -f <compose-file> ps -a
docker inspect <container>
docker logs <container>
```

If the old container was marked but not stopped, decide whether to finish or
roll back before touching it; the panel will not remove the marker. If the
candidate is unhealthy, inspect its logs. A normal `Up` recreates the service
with downtime; the panel never switches back by itself.

### Integration check

`tests/rollout-linux.test.ts` runs on a disposable lab daemon
(`scripts/docker-lab/run.sh`) with a real Traefik, continuous fast and slow
requests, and a second scenario where the candidate exits before becoming
healthy. It is opt-in and never runs in unattended CI.

## Optional managed-site deploy (ADR 0042, ADR 0043, ADR 0047)

This pilot deploys one public HTTPS or private SSH Git branch into an immutable release and
verifies the revision the gateway actually serves. It is off by default and
does not change ordinary stacks.

### Enable it

```bash
# deploy/compose-panel.env (or the environment of your panel container)
COMPOSE_PANEL_MANAGED_SITES_ENABLED=true
```

Then recreate the panel so the new environment is read:

```bash
docker compose -f deploy/compose.yaml up -d
```

The panel does not toggle this gate from the UI: it is a host/deployment
decision, and the supported deployment does not give the panel its own env
file. The panel image installs Git and the OpenSSH client. With the flag off
there is no deploy route, no site section and no manifest read.

### Create a generated site

With the flag on, **New site** on the Stacks page opens `/new-site`. The form
asks for a folder name, a site ID, a Compose project, a gateway port in
41000–41999, one pinned PHP channel, a public HTTPS or private SSH Git URL, a
fully qualified branch and optional persistent paths below `shared/`. **Preview
files** shows the exact manifest, `compose.yaml`, `generated/nginx-site.conf`
and `generated/opcache.ini`; nothing is written. **Create site** re-validates
everything server-side, validates the Compose file in its final folder and
writes the same bytes.

Creation does not pull an image, fetch code or start a container. It builds the
complete tree in a hidden draft and publishes it with one rename, so an
interrupted creation never leaves a half-managed stack that the panel can
operate. The gateway publishes `127.0.0.1:<port>` and has no domain yet. The
stack page then shows **Publish baseline**: it refuses while the site is
running, fetches the configured branch into the first immutable release and
points `current` at it. It is retryable, never touches a container and refuses
once a pointer exists. **Up**, **Start**, **Restart** and **Pull + up** are
refused until that baseline is provable. After that, **Up** starts the site and a
domain can be attached as described under Caddy. **Down** is refused while a
domain is attached.

With **Install Composer dependencies** checked, every release (the baseline and
each deploy) is prepared before it is published. A first read-only, offline
container checks that `composer.lock` is fresh for `composer.json`; a second
disposable `composer:2.10.3` container runs `composer install --no-scripts
--no-plugins`. The repository must commit `composer.lock`, must not commit
`vendor/`, and must declare `config.platform.php` for the chosen channel
(`8.3.x` or `8.4.x`); the lock's `platform-overrides.php` must match, because
that is the platform `composer install` actually verifies. The install container
sees only the staging tree, runs as the staging-tree owner and read-only, keeps
Composer's home and cache on a bounded tmpfs, and gets no secret, Docker socket
or production mount. The supported installer deployment runs the panel as root,
so the owner is uid 0; the container is still capability-dropped,
`no-new-privileges`, network-limited and resource-bounded, but this is
containment, not an unprivileged Unix user. A failed or oversized build removes
the attempt and leaves the active release untouched; if a container cannot be
proven removed, the operation reports an unknown outcome and the attempt is kept
for inspection. SIGTERM stops a running build before the panel drains. The host
must be able to pull the digest-pinned `composer:2.10.3` image or have it cached;
the panel does not pull it in advance. Registry credentials and private packages
are not supported ([ADR 0045](adr/0045-disposable-composer-preparation.md),
[ADR 0057](adr/0057-digest-pinned-tool-images.md)).

### Attach an existing database

A site may attach one database that the operator already provisioned. The panel
does not create a database, run SQL, migrate a schema or store a credential. It
adds one external network declaration and one private env-file reference, and
checks that the file is provisioned before the site starts.

1. Create the database, its database and its application account outside the
   panel, on a private Docker network. One engine per site: `mariadb`, `mysql`
   or `postgresql`.
2. For a generated site, edit `compose-panel-site.json` to set
   `"version": 2` and add the block below, then use **Regenerate generated
   files**. The creation form offers the same fields for a new site.
3. Write `<stack>/site/private/database.env` with the application's own
   variables (`DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, or
   whatever the application reads). It must be a regular file owned by the
   account that runs the panel, mode `0600`, and at most 64 KiB. The panel checks
   those metadata only; it never reads, logs or renders the values.
4. Create the external network if it does not exist yet (for example
   `docker network create acme-db`) and attach it to the database service.
   Only the runtime service joins it; the gateway stays on the project network.
5. **Up**, **Pull + up**, **Start**, **Restart**, **Rollout** and **Deploy** are
   refused with the file path until the env file passes those checks. A failed application
   connection is an application failure; it does not roll back the release.

```json
"version": 2,
"database": {
  "kind": "existing",
  "engine": "mariadb",
  "network": "acme-db"
}
```

The external network is shared by design. Tenant isolation is the database's
grants: create one database and one application account per site and verify that
one site's credentials cannot read another's data. The panel cannot verify those
grants. Dumps belong to the manual backup below; migrations and live restores are
not part of this attachment ([ADR 0048](adr/0048-existing-database-attachment.md),
[ADR 0049](adr/0049-offsite-backup-and-restore.md)).

### Manual offsite backup

A generated site may declare one Restic repository in its manifest, then the
stack page offers **Back up now**. The panel copies only the declared persistent
roots, optionally dumps exactly one MariaDB database, uploads with a pinned
Restic container and verifies the returned snapshot id. It never reads the
credential values, deletes a snapshot or starts a scheduler.

1. Create one Restic repository per site on a REST endpoint, preferably
   append-only behind TLS. The repository must survive the loss of the site
   host: either run it on an independent host, or include it in a provider
   snapshot that is replicated off that host. A separate DNS name or a TLS proxy
   on the same machine is not enough by itself, and a local repository does not
   protect against a compromised host that can delete it. The panel cannot
   verify this; it only sends the declared URL. Keep the repository password and
   an independently usable recovery credential off this host.
2. Create the fixed private directory and files, owned by the panel account:

   ```bash
   install -d -m 0700 /opt/stacks/acme-shop/site/private/backup
   install -m 0600 /dev/null /opt/stacks/acme-shop/site/private/backup/restic-password
   # optional REST basic auth, read by Restic through env_file:
   install -m 0600 /dev/null /opt/stacks/acme-shop/site/private/backup/rest.env
   ```

   Write the repository password to `restic-password`. `rest.env` may hold
   `RESTIC_REST_USERNAME` and `RESTIC_REST_PASSWORD` when the endpoint requires
   basic auth. The directory must stay `0700` and the files `0600`, regular and
   owned by the panel account; the panel refuses anything else.

3. For a SQL backup, create a **read-only** database role, distinct from the
   application account, and write a MariaDB client option file at
   `site/private/backup/database.cnf` (mode `0600`):

   ```ini
   [client]
   host=acme-db
   port=3306
   user=acme_backup
   password=<read-only password>
   ```

   Quote a password that contains spaces, `#` or quotes. The panel passes the
   file to `mariadb-dump` with `--defaults-extra-file` and never reads it. The
   role needs `SELECT`, `SHOW VIEW`, `TRIGGER` and `EVENT` on that database,
   because the fixed dump also reads routines, events and triggers and MariaDB
   refuses `--events` without the privilege. `LOCK TABLES` is not needed: the
   dump runs with `--single-transaction` and `--skip-lock-tables`. `EVENT` lets
   the account manage events but grants no access to the application rows.
   The digest-pinned dump image
   (`mariadb:11@sha256:e1d5495f445654134f226f55a41ce0da227116f6f27f283101f405c794d841fc`,
   about 460 MB) must be available: pull that exact reference once, because a
   first SQL backup that has to download it can exceed the operation budget. The
   reference is fixed by [ADR 0057](adr/0057-digest-pinned-tool-images.md) and
   listed in `src/managed-site-backup.ts`.

4. Edit `compose-panel-site.json` to `"version": 3` and add the block below,
   then use **Regenerate generated files** (the backup block itself changes no
   generated file, but the manifest change must be saved on the host). Omit
   `sql` for a files-only backup; `sql.engine` must equal the attached
   `database.engine`, and this slice supports MariaDB only.

   ```json
   "version": 3,
   "backup": {
     "kind": "restic",
     "repository": "rest:https://backup.example.test/acme-shop",
     "sql": { "engine": "mariadb", "database": "acme_shop" }
   }
   ```

5. **Back up now** runs one operation under the stack lock. A pending deploy or
   an unconfirmed backup refuses it. A proven failure clears its marker and can
   be retried; a timeout or an unverifiable upload keeps the marker, so inspect
   the repository and use **Acknowledge** before retrying. The panel records the
   accepted snapshot id in the operation output and the audit log, not in a
   recovery journal.

6. **List this site's snapshots** opens a read-only page that asks the pinned
   Restic client for this site's tagged snapshots and shows their ids and
   timestamps, newest first. It runs no `forget` or `prune`, extracts and deletes
   nothing, adds no credential and stores no list. **Choose** pre-fills the
   restore field below with that exact id; the list never starts a restore.

7. **Verify and restore** takes one exact snapshot id (not `latest`). It extracts
   the declared files into `site/private/backup/restore/<attempt>/`, checks every
   file against the recorded size and SHA-256, and imports a SQL snapshot into a
   disposable MariaDB container on an internal network with no production
   credentials, network or published port. It never writes over the live site.
   A failed component is reported and the private directory is kept.

8. **Check repository** asks the pinned Restic client for one bounded read-only
   check under the stack lock: the repository structure plus a random 32 MiB of
   pack data. It needs the same credentials as a backup, never repairs, deletes
   or unlocks, and stores no result. A clean answer means Restic found no errors
   in what it read; it is not a full `restic check --read-data` and does not
   replace the restore proof. Run that full check from the maintenance host
   before a prune.

The systemd timer is an administrator procedure
([Back up from a host timer](#back-up-from-a-host-timer)), and retention is
measured by a read-only preview
([Measure retention before pruning](#measure-retention-before-pruning)); the
panel still runs neither a scheduler nor a prune. The
isolated restore proof passes on the disposable lab, but no recovery from a real
endpoint or with the host credentials unavailable has been recorded yet. Compare
the preview with `restic forget --dry-run` on the maintenance host and complete a
recovery from a separate machine before treating these backups as operational
([ADR 0049](adr/0049-offsite-backup-and-restore.md),
[ADR 0052](adr/0052-retention-preview.md)).

The generated gateway resolves `runtime` through Docker's embedded DNS on every
request. Recreating the runtime can change its IP while the gateway container is
kept; a static upstream would keep dialing the old address and return 502.

The generated files are owned by the panel. Editing `compose.yaml` or
`generated/*` by hand is drift: every action is refused and names the file. Edit
`compose-panel-site.json` on the host, then use **Regenerate generated files**
on the stack page. A port change is refused while another managed site reserves
it, another container publishes it, or a Caddy domain still routes to this site.
Raw **Edit files** saving is refused for a generated site (and for any manifest
that cannot be used). Declared persistent paths resolve to
`<stack>/site/shared/...`; they are not chowned by the panel, so prepare their
ownership for the PHP image's user before relying on writes.

```bash
cd /opt/stacks/acme-shop
docker compose -p acme-shop -f compose.yaml up -d
curl -fsS http://127.0.0.1:41001/.compose-panel/revision
```

### Prepare an opt-in stack by hand

A managed site is an ordinary Compose directory with a trusted manifest next to
the Compose file. For `owner: "opt-in"` the panel never creates the layout or a
first release: the operator initialises both, exactly as
`scripts/managed-sites-lab/run.sh` demonstrates.

```text
/opt/stacks/acme-shop/
  compose.yaml
  compose-panel-site.json
  site/
    staging/                       # 0700, outside every mount
    runtime/
      releases/<full-sha>/          # immutable, 0755/0644
      current -> releases/<full-sha>
    shared/                        # optional explicit data mounts
    private/                       # 0700: release metadata, attempt marker
```

```bash
mkdir -p /opt/stacks/acme-shop/site/{staging,runtime/releases,private}
chmod 700 /opt/stacks/acme-shop/site/staging /opt/stacks/acme-shop/site/private
```

Publish one baseline release with `public/index.php` and
`.compose-panel/revision.php`, write
`site/private/releases/<sha>.json` with
`{"version":1,"siteId":"acme-shop","release":"<sha>","status":"complete"}`, and
point `current` at `releases/<sha>`. The deploy refuses an unprovable baseline:
there is no first deployment without a rollback target in the pilot.

The Compose project must declare its exact name, mount `site/runtime` read-only
at the same host and container path in the gateway and runtime services, publish
exactly one `127.0.0.1` TCP port on the gateway, expose no port on the runtime,
and keep every service on the project's own network (no `external: true`). The
gateway must serve the fixed probe route:

```nginx
location = /.compose-panel/revision {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /opt/stacks/acme-shop/site/runtime/current/.compose-panel/revision.php;
    fastcgi_pass php:9000;
}
```

A minimal `compose-panel-site.json` for a hand-written stack:

```json
{
  "version": 1,
  "siteId": "acme-shop",
  "owner": "opt-in",
  "project": "acme-shop",
  "services": { "gateway": "web", "runtime": "php" },
  "publicRoot": "public",
  "runtime": { "profile": "php-front-controller" },
  "deploy": {
    "kind": "bind-mount",
    "git": { "url": "https://github.com/acme/shop.git", "ref": "refs/heads/main" }
  }
}
```

The manifest is administrator input: the browser never supplies a URL, ref,
path or command.

### Use a private Git repository

Set `deploy.git.url` to an explicit SSH URL such as
`ssh://git@git.example.com:2222/acme/shop.git` and retain the fully qualified
`deploy.git.ref`. Use a DNS hostname or IPv4 literal and simple path segments.
On the Git server, register a dedicated key with **read-only** access to this
repository. Use a key without a passphrase for the non-interactive fetch.

Install the private key and a separately verified host key on the panel host.
For the default root-owned panel deployment, run these as root:

```bash
site=/opt/stacks/acme-shop/site
install -d -m 0700 "$site/private/ssh"
install -m 0600 /secure/input/acme-shop-deploy-key "$site/private/ssh/identity"
install -m 0600 /secure/input/acme-shop-known-hosts "$site/private/ssh/known_hosts"
```

Use a standard OpenSSH `known_hosts` entry for the exact destination.
For port 22 use `git.example.com`, and for the example port use
`[git.example.com]:2222` as the host field. Verify the server key fingerprint
with the Git host administrator or another independent trusted source before
installing the file. An unknown or changed key blocks the fetch. Rotate either
file between deployments and revoke the old deploy key at the Git server.

The panel UID must own `site/staging`, `site/private`, `site/private/ssh`
and both files. Keep those directories at `0700`, the files at `0600` and the
stack and `site/` directories writable by their owner only. The two credential
files must be regular, single-linked files of at most 64 KiB. Keep `site/private`
outside service mounts. A source installation requires Linux, `/usr/bin/ssh`
and an executable `src/scripts/git-ssh.sh` in the checkout.

If an SSH fetch is refused, check those files and their ownership, the
destination and branch, and the server-side key registration. On a disposable
stack, verify a deploy with the correct key pair, then repeat with an unrelated
deploy key and with a deliberately wrong host pin. Each refusal should leave
the current SHA and gateway serving the same release. SSH fetch output stays
out of the operation view and audit log.

### What a deploy does

The stack page shows **Deploy refs/heads/main** only when the flag is on and the
manifest is valid. One click, then the operation streams its phases:

1. Re-read the manifest, resolve the effective Compose project without `-p`,
   check the profile, the mounts, the networks and the runtime image identity.
2. Prove the baseline: `current`, its completed metadata, its revision script
   and the `/.compose-panel/revision` probe must agree on one full SHA.
3. Fetch the configured branch (depth 1) into
   `site/staging/<attempt-id>`, resolve the full SHA, verify the tree and
   publish `site/runtime/releases/<sha>` by one rename. The transfer is capped
   while it runs; a repository that downloads too many bytes is stopped and the
   attempt's staging directory is removed.
4. Briefly stop the gateway, switch `current`, force-recreate the runtime,
   start the gateway and probe until the body is exactly the intended SHA. The
   runtime container ID must change, its image ID must still be the running one,
   and the gateway container must keep its identity.
5. On a failed probe, repeat the same sequence in reverse: stop and confirm the
   gateway, return the pointer, recreate the runtime, start the gateway and
   probe again. The result says **rolled back** only when that probe succeeds.

A deployment of the SHA already served is a no-op only when the pointer,
metadata and probe all agree. The site is unavailable between the gateway stop
and start; this is part of the pilot contract, not hidden.

### Failures and recovery

The panel writes `site/private/deploy-attempt.json` before the first stop and
removes it only when the gateway is confirmed running on the release it must
serve. If it remains (crash, timeout, unconfirmed command, failed restoration),
the stack page reports an unconfirmed outcome and **refuses Up, Down, Start,
Stop, Restart, rollout, app actions, raw save and a new deploy** until you
inspect the host and acknowledge it. The refusal is checked again under the
stack lock, so a request that passed an earlier check cannot slip in after the
incident. Reads, logs and the probe stay available. Nothing is resumed or
retried automatically.

Inspect the three facts separately:

```bash
readlink /opt/stacks/acme-shop/site/runtime/current
docker compose -p acme-shop -f /opt/stacks/acme-shop/compose.yaml ps -a
curl -fsS http://127.0.0.1:<port>/.compose-panel/revision
cat /opt/stacks/acme-shop/site/private/deploy-attempt.json
```

To finish or undo by hand, use the same commands the panel uses:

```bash
# finish the switch to a known release
ln -sfn releases/<sha> /opt/stacks/acme-shop/site/runtime/.current.tmp
mv -T /opt/stacks/acme-shop/site/runtime/.current.tmp /opt/stacks/acme-shop/site/runtime/current
docker compose -p acme-shop -f /opt/stacks/acme-shop/compose.yaml up -d --no-deps --no-build --pull never --force-recreate php
docker compose -p acme-shop -f /opt/stacks/acme-shop/compose.yaml start web
curl -fsS http://127.0.0.1:<port>/.compose-panel/revision
```

When the pointer, Docker state and probe are what you intend, use
**Acknowledge attempt <id>** on the stack page. The form is bound to the attempt
ID it displayed, takes the stack lock and re-reads the marker; a mismatch
refuses. Deleting the marker without inspecting the site only removes the
guard.

### Trigger a deploy from CI

A generated site can let one pipeline promote the exact commit it tested
without giving the pipeline the administrator password. The panel stores only a
SHA-256 verifier; the token stays in the CI secret store.

1. Generate a token and its digest, and provision the fixed files:

   ```bash
   token=$(openssl rand -hex 32)
   printf '%s' "$token" | sha256sum | cut -d' ' -f1 > /tmp/deploy-token.sha256
   install -d -m 0700 /opt/stacks/acme-shop/site/private/ci
   install -m 0600 /tmp/deploy-token.sha256 \
     /opt/stacks/acme-shop/site/private/ci/deploy-token.sha256
   rm /tmp/deploy-token.sha256
   ```

   Store `$token` in the CI secret store; never keep it on the panel host. The
   file must be a regular `0600` file, one link, owned by the panel account and
   at most 256 bytes, inside a `0700` directory. A missing or malformed verifier
   answers `401` and the site page shows why.

2. Set `"version": 3` and add `"ci": { "kind": "token" }` to
   `compose-panel-site.json`. The block changes no generated file. Managed sites
   only; the request must use the configured `deploy.git.ref`.

3. Send one request with the tested commit. On the host, call the loopback
   listener directly; a remote CI uses the reviewed TLS proxy.

   ```bash
   sha=$(git rev-parse HEAD)
   curl -fsS -X POST https://panel.example.com/api/managed-sites/acme-shop/deploy \
     -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d "{\"sha\":\"$sha\",\"ref\":\"refs/heads/main\",\"nonce\":\"$(openssl rand -hex 16)\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}"
   ```

   `202` means accepted, with `{ "siteId", "sha", "operationId" }`. `400` is a
   malformed request, `401` a bad credential, `409` a busy stack, a pending
   marker, a replayed nonce or a branch that moved before the deploy, and `503`
   a panel shutting down or updating itself. The nonce is single-use and the
   timestamp must be within 300 seconds of the panel clock.

   Two limits were measured on a real host. The installer's Caddy entry protects
   **every** panel route with Basic Auth, and Basic Auth and a bearer token both
   use the `Authorization` header, so a remote CI behind that proxy cannot
   present both: Caddy answers `401` before the panel sees the request. Until a
   proxy route excludes `/api/managed-sites/*`, trigger the endpoint from the
   host loopback or through a proxy that adds no Basic Auth. A SHA that is no
   longer the branch tip is still accepted with `202` and then refused by the
   fetch, before anything is stopped (the audit log records `started` then
   `refused`), so treat `202` as "accepted", not "deployed".

4. The fetch must still resolve the configured ref to `sha`; otherwise the
   deploy is refused before anything is stopped. Trigger CI from the branch tip
   and do not reuse a request body.

5. Read the bounded status with `GET` on the same path and the same token; it
   returns the site, ref, current release and last attempt, never output. Revoke
   by deleting the verifier file or removing the `ci` block, and rotate by
   writing a new digest: no restart is needed.

### Back up from a host timer

The panel runs no scheduler. An administrator-installed systemd timer can ask
the panel for the same guarded backup, so the stack lock, the markers and the
one-process admission stay in one place.

1. Generate a **backup** token and its digest; do not reuse the deploy token:

   ```bash
   token=$(openssl rand -hex 32)
   printf '%s' "$token" | sha256sum | cut -d' ' -f1 > /tmp/backup-token.sha256
   install -m 0600 /tmp/backup-token.sha256 \
     /opt/stacks/acme-shop/site/private/backup/trigger-token.sha256
   rm /tmp/backup-token.sha256
   ```

   The private backup directory must already exist as `0700` and hold the
   Restic credentials. The digest file is a regular `0600` file, one link, at
   most 256 bytes; a missing or malformed verifier answers `401` and the card
   shows why.

2. Add the trigger to the existing backup block in `compose-panel-site.json`.
   The interval must cover the timer period; it is the maximum age before the
   card and the status report the backup overdue.

   ```json
   "backup": {
     "kind": "restic",
     "repository": "rest:https://backup.example.test/acme-shop",
     "trigger": { "kind": "token", "everyHours": 24 }
   }
   ```

3. Store the raw token root-only:

   ```bash
   install -d -m 0700 /etc/compose-panel
   ( umask 077; printf 'TOKEN=%s\n' "$token" > /etc/compose-panel/backup-token.env )
   ```

The timer runs this root-only request script. The service below invokes it with
`/bin/sh`, so it needs no shebang or exec bit and the file stays `0600`:

```bash
cat > /usr/local/sbin/compose-panel-backup-trigger <<'SH'
set -eu
. /etc/compose-panel/backup-token.env
curl -fsS -X POST http://127.0.0.1:5081/api/managed-sites/acme-shop/backup \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"nonce\":\"$(openssl rand -hex 16)\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"}"
SH
chmod 0600 /usr/local/sbin/compose-panel-backup-trigger
```

`202` means the request was accepted and the backup continues in the panel; the
timer run ends when `curl` returns. `400` is malformed, `401` a bad credential,
`409` a busy stack, a pending marker or a replayed nonce, and `503` a panel
shutting down. The nonce is single-use and the timestamp must be within 300
seconds.

4. Add the service and timer, then enable the timer:

   ```ini
   # /etc/systemd/system/compose-panel-backup-acme-shop.service
   [Unit]
   Description=Compose Panel backup request for acme-shop
   After=network.target

   [Service]
   Type=oneshot
   ExecStart=/bin/sh /usr/local/sbin/compose-panel-backup-trigger
   ```

   ```ini
   # /etc/systemd/system/compose-panel-backup-acme-shop.timer
   [Unit]
   Description=Daily Compose Panel backup request for acme-shop

   [Timer]
   OnCalendar=*-*-* 03:30:00
   RandomizedDelaySec=300
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

   ```bash
   systemctl daemon-reload
   systemctl enable --now compose-panel-backup-acme-shop.timer
   ```

   `Persistent=true` catches up a run missed while the host was off; a panel
   outage at the scheduled moment is not retried by the panel and shows as
   overdue on the next page load. A manual backup at the same time returns
   `409`, and neither request is replayed.

5. Confirm the outcome from the site card or
   `GET /api/managed-sites/acme-shop/backup` with the same token. It returns the
   declared interval, the last attempt, the last good snapshot, the last
   verified restore, `overdue` and `dueAt`, never output. Revoke by deleting the
   digest file or removing `backup.trigger`; rotate by writing a new digest. The
   panel deletes no snapshot: retention stays an off-panel procedure.

### Measure retention before pruning

The panel measures a declared policy; it never applies it. Retention stays an
operator procedure on the maintenance host with a deletion credential that the
panel does not hold.

1. Declare the policy the maintenance host will use. Start conservatively and
   compare the preview with the real dry-run before pruning anything. The block
   changes no generated file and authorizes no deletion.

   ```json
   "backup": {
     "kind": "restic",
     "repository": "rest:https://backup.example.test/acme-shop",
     "retention": { "keepLast": 7, "keepDaily": 14, "keepWeekly": 8, "keepMonthly": 12 }
   }
   ```

   At least one count is required; each is bounded (`keepLast` 1–100,
   `keepDaily` 1–365, `keepWeekly` 1–104, `keepMonthly` 1–120). Hourly, yearly,
   within and tag policies are not accepted yet.

2. Open the site page and press **Preview retention**. The operation asks the
   pinned Restic client for this site's tagged snapshots and runs `forget
   --dry-run` with exactly the declared counts. It reports how many snapshots
   Restic would keep and remove, lists the exact removal ids, and warns when the
   removal set contains the last good snapshot or the last verified restore. It
   deletes nothing and stores no preview. A repository lock, a pending backup
   marker or a missing credential file refuses the preview.

3. On the maintenance host, with a credential that can delete (the panel's
   backup credential is append-only), run the real dry-run and compare it with
   the panel preview:

   ```bash
   restic -r "$REPOSITORY" forget --dry-run --tag site:acme-shop \
     --keep-last 7 --keep-daily 14 --keep-weekly 8 --keep-monthly 12
   ```

   If the sets differ, stop and inspect the repository; do not prune.

4. Run `forget` without `--dry-run`, then `restic check`, then restore one
   remaining snapshot and read a protected file and its database record back.
   Never run a backup while a prune runs, and never prune the last verified
   recovery point. Record the removal ids and the check result.

### Verification status

Unit tests cover the manifest, the profile check, the Git adapter, the fixed
Composer preparation and the deploy decision table, including rollback and
unconfirmed outcomes. Creation
tests cover deterministic generation, the manifest-last write and directory
modes, the reserved port and project refusal, the baseline action, raw-save
refusal, drift in the admission hook and explicit regeneration. The Composer
build is exercised by unit tests (fixed argv and isolation flags, offline lock
check, pre-Docker refusals, size monitor, cancellation, removal proof, sanitized
failures) and by the disposable suite, which runs the real image on a fresh
zero-dependency lock, refuses a lock whose dependency needs PHP 8.4 on the 8.3
channel, and sends SIGTERM while an install is blocked to prove the container is
removed. The generated
gateway policy was also exercised by hand on a disposable Docker daemon: the
probe and front controller served the same SHA, while the probe's `.php` name,
an uploaded `.php` file and the manifest were not served. The disposable
deployment suite now also starts a site from the generated files, force-recreates
the runtime, proves its IP changed while the gateway container ID stayed the
same, and checks that the gateway recovers the probe and front controller
through Docker DNS. The
disposable layout lab (`bun run test:managed-sites:wsl`) proves the mount,
switch, forced-recreation and probe contract without the panel. The disposable
deployment suite (`bun run test:managed-sites-e2e:wsl`) drives the real deploy
code against a real Git repository and Compose project: two commits, a proven
no-op, a return to the previous release, two refusals before any mutation, and
two SIGKILLs (after the gateway stop and after the pointer switch) followed by
an inspection of the marker, pointer, containers and probe. It also builds a PHP
8.3 image with `pdo_mysql`, starts MariaDB 11 in a separate project on an
external network, writes a record through the site, deploys the next commit,
rolls back and reads the same record, and proves that site A's account cannot
read or write site B's table (ADR 0048). The manual backup and verified restore
(ADR 0049) are covered by unit tests for the manifest block, credential
metadata, staging walk and quotas, the fixed dump/Restic argument arrays,
snapshot parsing, restore inventory/hash checks, the disposable SQL import, the
routes, admission and acknowledgement, with a fake runner and no host Docker
access. The disposable suite adds an append-only `restic/rest-server`, uploads a
real staging tree, deletes the file, restores it with `restic restore <id>`,
runs the read-only retention preview for two snapshots (keep one, remove one),
and proves that a prune still leaves the snapshot listed. A second fixture
dumps one MariaDB database through `database.cnf`, deletes the record from the live
database, runs the real restore runner into its disposable instance, and imports
the restored dump elsewhere to read the record back; the live database still
reports the deletion. No recovery from a real endpoint or with the host
credentials unavailable has been claimed. The CI-triggered deploy (ADR 0050) is
covered by unit tests for the verifier metadata and digest, the strict request
body and window, nonce consumption/replay and the durable state, and by app
tests for the missing/wrong token, the absent `ci` block, a malformed body or
content type, one accepted request under the lock, a replay and the bounded
status; the browser session alone is refused. No CI host, proxy path or
revocation has been exercised on a real host. The timer-triggered backup
(ADR 0051) is covered by unit tests for the trigger block, the verifier, the
strict nonce/timestamp body and window, nonce replay and the durable facts, and
by app tests for the untriggered site, the cookie-only request, the wrong token,
the wrong content type, the accepted backup with its recorded last-good
snapshot, a failed run that keeps the previous snapshot, the recorded restore
proof, the overdue state and the rate limit; no
host timer or real revocation has been exercised. The retention preview
(ADR 0052) is covered by unit tests for the declared counts, the exact dry-run
argv, the tagged inventory, Restic's keep/remove split, the cross-check and the
protected-fact helper, and by app tests for the session-less, stale-form,
missing-policy and pending-marker refusals, one accepted dry-run and an
inconsistent reply; the disposable REST fixture runs the same preview against
the append-only lab repository and its delete attempt is still refused. No
off-panel prune has been compared with a preview yet. The disposable SSH
fixture (`bash scripts/test-git-ssh.sh`) drives the real Git adapter against
OpenSSH on loopback and exercises the correct key pair, wrong client key and
wrong host key. These suites are opt-in and
never run in unattended CI; do not treat a production host as its test bed.

#### Remaining real-host validation

The disposable suites prove the release, mount, probe and failure logic on a
private Docker-in-Docker daemon, not the host path that serves a real site.
They do not cover the installer and host packages, the systemd Caddy helper and
its socket, public DNS/TLS, the actual proxy header chain, a host reboot, two
sites on one host, or the Debian/Ubuntu mount and permission behaviour. The
checklist below was run and recorded on a disposable Ubuntu 26.04 VPS on
2026-11-27 ([record](validation/managed-site-pilot-2026-11-27.md)): eleven of the
twelve lines pass, and CI through the installed TLS proxy stays partial for the
Basic Auth/Bearer conflict. Enabling the pilot on a production host remains an
explicit operator decision, the flag stays off by default, and the published
image must still be installed by digest and rerun before that path is called
validated. The disposable suites are never run against a production daemon.

1. Run the installer on a disposable VM and verify the panel health, the Caddy
   helper socket and `docker compose version`.
2. Enable `COMPOSE_PANEL_MANAGED_SITES_ENABLED`; create two sites on the two
   offered channels and confirm the reserved ports, the generated files and the
   absence of drift.
3. Attach a domain to one site through Caddy; verify HTTPS, redirects and the
   trusted-proxy chain from the real edge to the gateway.
4. Publish the baseline, deploy twice, prove the no-op, roll back, then kill the
   panel before and after the switch; restart and inspect the attempt marker,
   the pointer, the containers and the probe.
5. Force-recreate the runtime and confirm the gateway recovers through Docker DNS
   and serves the expected SHA.
6. Detach the domain, run Down, Start, Stop and Restart; confirm that no stale
   reservation or attempt blocks the next action.
7. Revoke the deploy key and confirm the next deploy fails closed without
   touching the active release.
8. Trigger one CI deploy through the reviewed TLS proxy with a rotated token,
   confirm the exact tested SHA is served, refuse a stale SHA after a new
   commit, and revoke the verifier; confirm the next request is `401` and the
   active release is unchanged.
9. Install one backup timer, record one accepted run and its last-good
   snapshot, stop the timer long enough to see overdue on the card and the
   status, then revoke the verifier and confirm the next request is `401` with
   the site unchanged.
10. Declare one retention policy, run one preview, compare its removal set with
    the off-panel dry-run, prune from the maintenance host, run `restic check`
    and restore one remaining snapshot; confirm the panel's protected ids were
    not removed.
11. List the snapshots from the site card and compare the ids with
    `restic snapshots --tag site:<siteId>` on the maintenance host; choose one,
    confirm the restore form holds that exact id, restore it and confirm the
    repository still lists the same snapshots after the list page.
12. Run **Check repository** and compare its clean answer with a full
    `restic check --read-data` on the maintenance host; confirm the operation
    added no lock object to the repository and no snapshot.

Record the result with the release or pilot review. The 2026-11-27 run is
recorded in [validation/managed-site-pilot-2026-11-27.md](validation/managed-site-pilot-2026-11-27.md).
Do not use a production host as the test bed.

## Backups and rollback

Two layers, both plain files:

1. **Per-save backups** made by the panel itself under
   `<root>/.compose-panel/backups/<stack>/` (previous `compose.yaml`/`.env`
   before each write). To roll a stack back, copy the backup over the live
   file, then `docker compose up -d` from that directory. The panel keeps the
   `COMPOSE_PANEL_BACKUP_RETAIN` (default 10) most recent backups of each file
   and deletes older ones after a save. "Delete all backups" on a stack's edit
   page removes them at once, for example after rotating a secret in `.env`
   (backups of `.env` contain its secrets). Only files the panel created are
   counted or deleted (ADR 0017).
2. **Host-level stacks backup** before upgrades or risky edits:
   `tar -czf /root/stacks-backup-$(date +%F).tar.gz -C /opt stacks`.
   Restore with `tar -xzf`, then re-read state in the panel.

### Updating from the browser

With the official image (`ghcr.io/lekoala/compose-panel`), **About**
(`/about`) updates the panel itself ([ADR 0018](adr/0018-self-update.md)):

1. **Check & download update** pulls the image tag the panel runs from.
   Nothing restarts. Use `image: ghcr.io/lekoala/compose-panel:latest` in
   `deploy/compose.yaml` to follow releases: a version tag such as `0.3.0`
   stays on that release version rather than following new releases.
2. For a newer image, the panel asks GitHub for the release of that exact
   version and the repository's versioned release registry (two bounded
   requests, no token). The image is installable only when the release is
   published (not a draft, not a prerelease), its digest matches the latest
   registry record and the downloaded image, and **72 hours** have passed since
   both publication and digest registration. A replacement digest is recorded
   in Git and waits again; an identical retry preserves the date. Otherwise **About**
   says why, or when the release becomes installable. There is no bypass in
   the panel: to update sooner, use the host commands below.
3. **Install update…** asks for a confirmation and checks everything again.
   It is refused while a stack action or save is running.
4. The panel starts a one-shot container, `compose-panel-updater`, from the
   image it runs now, with no network, the Docker socket and the deployment
   directory (read-only). The updater checks that the tag still resolves to
   the approved image with the release digest and that the Compose file still
   matches, tags the current image as `compose-panel:rollback`, runs
   `docker compose up -d --no-deps --no-build --pull never panel` (nothing is
   downloaded or built), then waits until the new container is healthy.
   Managed stacks are not touched.
5. The page reloads by itself when the panel is back. Sign in again (sessions
   live in memory). **About** shows the result, the previous and target images,
   the updater output and the rollback commands, read from the finished
   updater container. It stays in Docker until the next update
   (`docker logs compose-panel-updater` works from the host too).

Requirements, all read from Docker (no setting): the panel runs in a container
started by `docker compose`, from a pulled tag of the official image (not a
local build, not pinned by digest), with the socket bind-mounted at
`/var/run/docker.sock`, and all its Compose and env files inside the
deployment directory. If one is missing, **About** says which and the update is
done from the host as below. The panel reaches `api.github.com` only on Check
and Install. The updater applies the deployment files as they are on disk, like
a manual `compose up`. It does not depend on the panel process: if the panel is
stopped or restarted during an update, the updater keeps going, and the next
panel start shows its outcome. The 72-hour delay is a panel policy only: the
downloaded image stays usable from the host CLI.

**Rollback** to the exact image the panel ran before the last update (shown on
**About**, with the project's own `-p`/`-f` options filled in):

```sh
docker image tag compose-panel:rollback ghcr.io/lekoala/compose-panel:latest
cd /path/to/compose-panel/deploy
docker compose -p compose-panel -f /path/to/compose-panel/deploy/compose.yaml up -d --no-deps --no-build --pull never panel
```

Nothing is downloaded and no file is edited. The next Check downloads the newer
image again. `docker image prune -a` removes `compose-panel:rollback` once no
container uses it.

### Upgrade and rollback

For a local development image, build with `--build-arg VERSION=dev` (the
default) and `--build-arg REVISION="$(git rev-parse HEAD)"`. The footer and
About page show the package version with a `-dev` suffix and the first twelve
characters of the commit when supplied. Official release builds keep the plain
package version. These values identify the build inputs; they do not certify a
clean working tree. Running from source also shows `-dev`, without a commit.

Run these commands **on the host**, from the repository checkout, never from
inside the panel: recreating the panel container stops the process that would
run them. This is also the recovery path when an update from the browser fails.

1. Back up (layer 2).
2. Built locally: `git pull` (or check out the new tag), then
   `docker compose -f deploy/compose.yaml build`.
   Published image: set `image: ghcr.io/lekoala/compose-panel:<version>` in
   `deploy/compose.yaml`, then `docker compose -f deploy/compose.yaml pull panel`.
3. `docker compose -f deploy/compose.yaml up -d --no-deps panel`, then run the
   smoke checks below.

Rollback: check out the previous tag/commit and rebuild, or put the previous
version tag back in `image:` and pull, then `up -d --no-deps panel` again.
Stack files are untouched in either direction, and managed stacks keep running
while the panel restarts.

Removal without impact: `docker compose -f deploy/compose.yaml down`
removes only the panel container. Running services, networks and volumes are
untouched — verify with `docker ps` afterwards. Stacks remain fully manageable
by the `docker compose` CLI.

## Activity log

The panel writes an append-only audit log of sign-ins, saves and operation
starts as NDJSON, one file per day under
`<root>/.compose-panel/audit/` (inside the already-mounted stacks directory, so
no new volume is needed). The most recent `COMPOSE_PANEL_AUDIT_RETAIN_FILES`
files (default 31) are kept. A read-only view is available at `/audit` once
signed in. The log never contains passwords, hashes or `.env` values.

Useful variables: `COMPOSE_PANEL_AUDIT_ENABLED` (default `true`),
`COMPOSE_PANEL_AUDIT_DIR` (default the stacks path above),
`COMPOSE_PANEL_AUDIT_ROTATION` (`day` or `month`),
`COMPOSE_PANEL_AUDIT_RETAIN_FILES`, `COMPOSE_PANEL_AUDIT_MAX_FILE_BYTES`,
`COMPOSE_PANEL_AUDIT_MAX_READ_LINES`.

The activity log, the start time of an action and container logs are all shown
in one display time zone. Set `COMPOSE_PANEL_TIMEZONE` to an IANA name (e.g.
`Europe/Brussels`) to fix it for every reader; leave it unset to use each
reader's browser zone. Timestamps are always stored and emitted in UTC: this
only changes presentation, and an invalid zone is refused at startup.

Every failed login is a line like:

```json
{"ts":"2026-10-10T09:00:00.000Z","event":"login","result":"failure","actor":"203.0.113.7","username":"admin account","detail":"over limit, delayed"}
```

### Host-level ban (fail2ban / CrowdSec)

The panel throttles logins itself (a bounded delay, never a lockout), so a real
source ban belongs at the host, on the SSH daemon and on this audit file. This
is only meaningful behind Caddy (see [Behind Caddy](#behind-caddy-https)):
then `actor` is the client address, taken from the last `X-Forwarded-For`
entry, the one Caddy added. Through an SSH tunnel `actor` is `direct`. A
minimal fail2ban jail (NDJSON parsed with a regex filter), banning the HTTPS
ports Caddy listens on:

```ini
# /etc/fail2ban/filter.d/compose-panel.conf
[Definition]
failregex = "result":"failure".*"actor":"<HOST>"
```

```ini
# /etc/fail2ban/jail.d/compose-panel.conf
[compose-panel]
enabled  = true
port     = http,https
filter   = compose-panel
logpath  = /opt/stacks/.compose-panel/audit/*.log
maxretry = 10
findtime = 600
bantime  = 3600
```

Forwarded addresses are trusted only on a request whose Host matches a
`COMPOSE_PANEL_PROXY_ORIGINS` entry; through the loopback (SSH) path
`X-Forwarded-For` is ignored and `actor` is `direct`. Note the trust boundary
([ADR 0012](adr/0012-multiple-access-origins.md)): a client able to reach the
loopback listener can present a proxy-origin Host and forge the header, so this
is a best-effort attribution, not an authenticated proxy identity.

## Manual verification (release gate)

Audit hardening additions (run only with disposable fixtures):

- Inspect the image for `NODE_ENV=production`. Exercise a thrown handler through
  `tests/http-server.test.ts`: status 500, no-store and no exception details.
- Run `bun run test:docker-lab:wsl` (or the Linux lab script): real toolbox
  reads must accept the regular manifest and refuse directories, symlinks and
  oversized manifests; the panel writes no manifest to temporary storage.
  The metadata fixture also verifies real `ps`/`images` against an explicitly
  selected env file and with default `.env` discovery disabled.
- As an unprivileged Linux user, try a save whose original owner/group cannot
  be reproduced. Confirm the original stays intact, no `.cp-tmp-*` remains,
  and the editor reports failure. Run `tests/fs-safe.test.ts` on Linux for the
  isolated regression; pair-save rollback remains covered by editor tests.
- On a test repository/registry, publish and rerun the same digest: there is
  one registry record and its date stays unchanged. Retry with a replacement:
  a second record preserves the first and About waits another 72 hours. Edit
  only the release digest: the new panel must refuse the registry mismatch.
  Verify an HTTP response without Content-Length is canceled at the byte cap.
  Local tests use fake GitHub; no production release is edited during tests.

The new registry starts empty. The next successful publication records its
image. Older versions without a record can still be installed from the host;
the new self-updater refuses them. Commit `releases.json` to `master` before
running the new publication workflow. If default-branch protection refuses the
publication job's registry commit, resolve that policy through the repository's
normal review process; the workflow fails rather than publishing an unrecorded
release. No history is seeded with an unverified or backdated digest.

Automated CI builds the image, scans it and runs unit tests, but the
following need a real Linux host with Docker and are done by hand before any
release. Verified 2026-10-10 against image `compose-panel:local`
(linux/amd64, Bun 1.4.3, Compose v5.6.0, Docker Desktop Linux daemon):

- [x] Image builds (`docker build -t compose-panel:local .`).
- [x] Login smoke test: login page → 303 login → stack list shows the stack.
- [x] Read: detail page shows the Compose file and the real project state.
- [x] Validate + save: edited service saved (303), file on disk updated.
      Invalid drafts returning 400 is covered by unit tests (`editor` +
      `app` suites), not re-proven against the live daemon.
- [x] `up`: pulls the image, creates network/container, SSE reports
      `succeeded` exit 0; detail shows the real container state afterwards.
- [x] `down`: stack returns to `not-created`, no leftover containers.
- [x] Without a socket mount, `up` fails honestly (`failed`, exit 1, Docker's
      error in the output, state `unknown`) — no invented success.
- [x] Interruption/restart: `docker restart` invalidates the old session
      (`/` → 302, re-login required), health stays `ok`, files intact.
- [x] Removal: deleting the panel container leaves the daemon healthy and
      stack files untouched.
- [x] Reverse proxy mode behind Caddy 2.8.4 with TLS (2026-10-10, WSL Ubuntu
      24.04, fake `docker`): `scripts/proxy-e2e/run.sh` passes 14/14 — Secure
      cookies, foreign Origin and Host refused, forged `X-Forwarded-For` ignored,
      live SSE for actions and logs, UTF-8, sign-out closes open streams.
- [x] Multiple access origins ([ADR 0012](adr/0012-multiple-access-origins.md)):
      `scripts/proxy-e2e/run.sh` with two TLS origins and the coexisting loopback
      path passes 20/20 (2026-10-11, WSL Ubuntu 24.04, fake `docker`) — both
      origins accepted with Secure cookies, loopback non-Secure, a cross-path
      Origin refused.
- [ ] Same check on the target host with its real Caddy and a real stack.
- [x] Self-update logic ([ADR 0018](adr/0018-self-update.md)) on the disposable
      lab daemon (`bun run test:docker-lab:wsl`, 2026-10-12, Docker 29.9.0):
      real Compose labels are read; a stale target or a digest the image does not
      carry is refused with nothing changed; with a registry inside the lab, the
      approved image is installed and verified healthy, a second service keeps
      its container, `compose-panel:rollback` holds the previous image and the
      documented rollback brings it back. Pulling multi-platform `alpine` by tag
      records the index digest from `buildx imagetools inspect` in `RepoDigests`
      (amd64, containerd image store of the lab daemon).
- [x] Targeted operations, filtered logs and pull policy ([ADR 0019](adr/0019-start-action.md),
      [ADR 0020](adr/0020-filtered-service-logs.md),
      [ADR 0021](adr/0021-targeted-service-operations.md),
      [ADR 0022](adr/0022-pull-ignores-buildable-services.md)) on the disposable
      lab daemon (`bun run test:docker-lab:wsl`, 2026-10-12, Docker 29.8.1):
      `start` brings stopped containers back, scoped `restart --no-deps` leaves
      a stopped dependent alone, scoped `up --no-deps` does not start
      dependencies, `?service=&tail=` reads through the `--` separator,
      `config --services` discovery and refusals work, and `pull` succeeds on a
      stack mixing registry, build-only and image+build services (the local
      ones are skipped, then built by `up`).
- [x] Remote image check ([ADR 0041](adr/0041-targeted-pull-and-remote-image-check.md))
      on the disposable lab daemon (`bun run test:docker-lab:wsl`,
      2026-11-21, Docker 29.9.0, containerd image store): a tag that did not move
      is **Up to date**, a republished tag is **Update available** and nothing is
      downloaded by the check, a registry tag deleted after its local pull is
      **Unknown**, a `build:` service is Not checked, a CLI pull outside the
      panel moves the local digest so the same registry state becomes Up to
      date on the next check (after a scoped Up recreates the row from the
      current image), and a restart action drops the stored verdict from the
      page. The buildx client runs on the host side and resolves the lab
      registry through the loopback mapping added by `scripts/docker-lab/run.sh`.
- [ ] Remote image check with a private registry through a mounted
      `DOCKER_CONFIG` (the 401 path is covered by classification tests; the
      authenticated read was verified in the ADR 0041 spike).
- [x] Buildx state with read-only credentials (2026-11-21, WSL Ubuntu 24.04,
      buildx 0.37.2): `DOCKER_CONFIG` on a read-only directory fails with
      `mkdir <config>/buildx: permission denied` before any registry request;
      the same command with a writable `BUILDX_CONFIG` succeeds. The panel sets
      that variable (or an ephemeral fallback) for every check, covered by a
      provider test.
- [ ] Remote image check with a private registry through a mounted
      `DOCKER_CONFIG` **and** a writable `BUILDX_CONFIG`, end to end with real
      credentials (the 401 path is covered by classification tests; the
      authenticated read was verified in the ADR 0041 spike).
- [x] Real updater container on the disposable lab daemon (2026-10-12,
      Docker 29.9.0, amd64): the panel image built in the lab, deployed by
      Compose on `PORT=5199` (healthy: the image health check follows `PORT`),
      a newer image pushed to a lab registry, then `compose-panel-updater`
      started with the arguments the panel builds: exit 0, new container on the
      target image and healthy, `compose-panel:rollback` on the previous image,
      updater labels read back.
- [ ] Self-update end to end with the published image on a disposable host,
      on amd64 **and** arm64, and with the classic image store as well as the
      containerd one: deploy `ghcr.io/lekoala/compose-panel:latest` at the
      previous version, publish the new one (the GitHub Release carries the
      digest line), Check: the release shows a waiting period, then (72 hours
      later, or with a release old enough) Install; the panel comes back on the
      new version, `compose-panel-updater` exited 0, managed stacks untouched,
      the rollback commands from About bring the previous image back. Then make
      it fail (for example change `image:` in `deploy/compose.yaml`) and
      confirm "Refused, nothing changed" with the panel still running.

## Audit correction verification

The checklist above refers to the previously built image. Source corrections
after that image require separate verification; no rebuild or deployment was
performed as part of the correction work.

- [x] Isolated Linux child-process fixtures: a mutation runner timeout and a
      provider log abort both terminate a child ignoring `SIGTERM`; split UTF-8
      remains intact. Verified in WSL Ubuntu 24.04 with Bun 1.4.0; CI uses pinned
      Bun 1.4.2, which remains the supported minimum.
- [x] HTTP/provider fixtures: refuse conflicting new project names, drain an
      accepted save, bound a stuck save and refuse overlapping log follows.
- [x] Real config-only Compose verification (WSL, Compose 5.5.1): process
      environment overrides `.env`; `.env` overrides YAML `name:`; YAML name
      overrides the directory fallback. The collision refusal uses fixture
      discovery and real config resolution; no daemon command was issued.
- [ ] Before releasing the rebuilt image, use a disposable Linux daemon to
      create a project from one directory and request `up` from another directory
      with the same `name:` (and then with `COMPOSE_PROJECT_NAME` in `.env`).
      Expect 409 and unchanged original containers. A unique name must use the
      resolved `-p` identity and still work from the ordinary Compose CLI.
- [ ] Follow real logs containing partial lines and non-ASCII text; confirm exact
      text, stop the last reader, then follow again after process termination.
- [ ] Send `SIGTERM` while a save is validating and while an operation is running;
      confirm new requests are refused, accepted work drains within the shared
      deadline and no containers already started are stopped by panel shutdown.

Never use a production daemon for these release checks. Unknown outcomes after
the shared deadline or a crash still require inspecting files and Docker state.
