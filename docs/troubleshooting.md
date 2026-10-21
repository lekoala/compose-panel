# Troubleshooting

Short, symptom-first fixes for the problems seen most often in a real
deployment. Each entry gives the symptom, the likely cause, a command to check,
and a safe fix. Nothing here asks you to run an action on a stack that is still
serving traffic.

For deployment steps themselves, see [deployment.md](deployment.md); for the
Dockge switch-over, [migrating-from-dockge.md](migrating-from-dockge.md).

## Sign-in is refused

### "Sign-in was blocked because the request did not come from this panel's own page"

- **Cause:** the browser sent an `Origin` (or a `Referer` that produced one) that
  does not match the access path the request arrived on. This is the panel's
  CSRF/origin protection, not a wrong password.
- **Diagnose:** the panel names both sides in the activity log (`/audit`,
  sign-ins), for example `origin blocked: received …, expected …`.
- **Fix:** open the panel at the exact address you configured.
  - If you set a proxy origin, use that `https://…` address, not the SSH tunnel.
  - If a reverse proxy adds redirects, sign in at the final URL it serves.
  - Behind a reverse proxy, make sure it preserves the original `Host` header
    (Caddy and `cloudflared` do by default).

### "The sign-in form expired"

- **Cause:** the double-submit CSRF cookie was missing or different from the
  token in the form — usually a stale tab, a cookie from an earlier address, or
  two sign-in tabs open at once.
- **Diagnose:** check the browser's cookies for the panel's host; the panel sets
  `cp_csrf` and `cp_session`.
- **Fix:** delete the cookies for the panel's domain only (not all browser
  data), reopen one tab at the configured address and sign in again. If it
  persists across tabs, that is the known limitation tracked in
  [roadmap.md](roadmap.md) ("Login CSRF across tabs and access modes").

### The SSH tunnel works but sign-in keeps failing

- **Cause:** on 0.1.0 a configured `COMPOSE_PANEL_PUBLIC_ORIGIN` makes Origin
  checks strict for that origin, so forms posted through
  `http://127.0.0.1:5081` are refused on purpose. This is not a broken tunnel.
- **Diagnose:** the activity log shows a refused sign-in with `expected
  https://…`.
- **Fix:** use one access path at a time on 0.1.0. From 0.2.0 you can keep both:
  set `COMPOSE_PANEL_PROXY_ORIGINS` **and** `COMPOSE_PANEL_ALLOW_LOOPBACK=true`
  ([ADR 0012](adr/0012-multiple-access-origins.md), [deployment.md](deployment.md)).

## A stack is missing or shows `unknown`

- **Cause:** the panel matches Docker projects to Compose files by path. If the
  stacks folder is mounted at a different path inside the container than on the
  host, or the file has an unsupported name, the match fails.
- **Diagnose:**

  ```sh
  # What the panel sees:
  docker inspect compose-panel --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
  # What Docker recorded for a stack's container:
  docker inspect <container> --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
  ```

- **Fix:**
  - Make host path and container path identical (`/opt/stacks:/opt/stacks`) and
    set `STACKS_DIR` to that path.
  - A stack needs exactly one Compose file per folder (`compose.yaml`,
    `compose.yml`, `docker-compose.yaml` or `docker-compose.yml`). Folders with
    an override file, several Compose files, or a symbolic link are refused
    on purpose; see [migrating-from-dockge.md](migrating-from-dockge.md).

## Logs are empty

- **Cause:** the panel reads logs through `docker compose logs`. A stack that is
  not deployed, or whose containers never wrote output, shows nothing.
- **Diagnose:** compare from the host, in the stack folder:

  ```sh
  cd /opt/stacks/<stack> && docker compose logs --tail 200 --timestamps
  ```

  Run this on the host, not inside another container's terminal, where the
  Compose plugin may be absent.
- **Fix:** if the command shows output but the panel does not, reload the page
  (the panel loads the last `COMPOSE_PANEL_LOG_TAIL_LINES` lines when the stack
  page opens). Use *Follow live* to stream new lines.

## The Health check column is empty

- **Cause:** Docker has no health check configured for those services. The
  column is hidden entirely when no service declares one; otherwise a service
  without a check shows *Not configured*.
- **Diagnose:** `docker inspect <container> --format '{{json .Config.Healthcheck}}'`
  (empty/null means none).
- **Fix:** this is not a fault. A `Running` container without a health check can
  still be unhealthy at the application level; add a `healthcheck:` to the
  service if you want Docker to judge it, then recreate the container with *Up*.

## A `.env` change has no effect

- **Cause:** saving only writes the file; running containers keep the
  environment they were created with. **Restart** reuses the same container, so
  it keeps the old values too. Less often, the variable is in `.env` but the
  service never receives it (it is not listed under `environment:`).
- **Diagnose:** the service is marked **Recreate pending** on the stack page
  (Compose 5.5.0 or later). On the host, compare the container's creation time
  with the save (`docker compose -p <project> ps`), or print only the variable
  concerned, never the whole environment, which may hold secrets:
  `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' <container> | grep '^NAME='`.
- **Fix:** run **Up** on the service (or the stack). It recreates the
  container with the new values; expect a short interruption for a single
  instance. For runtime settings such as PHP directives, `.env` also needs a
  bridge to the runtime: see
  [integrations/runtime-settings.md](integrations/runtime-settings.md).

## `docker compose` works on the host but not in another container

- **Cause:** the Compose plugin is installed on the host and in the panel image,
  but not necessarily inside an unrelated container, even when the Docker socket
  is mounted.
- **Diagnose:** `docker compose version` in the container's own terminal.
- **Fix:** run Compose commands from the host or from the panel. The panel ships
  its own Docker CLI and Compose plugin.

## Which Caddyfile is actually active?

- **Cause:** a Caddy running as a systemd service reads `/etc/caddy/Caddyfile`,
  while a Caddy run as a container/stack reads the file inside that stack
  (for example `/opt/stacks/caddy/Caddyfile`). Editing the other one has no
  effect.
- **Diagnose:**

  ```sh
  systemctl status caddy --no-pager
  caddy validate --config /etc/caddy/Caddyfile
  ```

- **Fix:** edit the active file and reload: `systemctl reload caddy`. Point the
  panel's site at `reverse_proxy 127.0.0.1:5081`. A folder with only a
  `Caddyfile` is not a Compose stack and will not appear in the panel.

## Containers leave zombie processes

- **Cause:** a container's process is PID 1 and does not reap orphaned children,
  so exited children stay as zombies (`<defunct>`).
- **Diagnose:** inside the container, `ps -eo stat,pid,ppid,comm | grep Z`, or on
  the host `docker top <container>`.
- **Fix:** add `init: true` to the service so a tiny init reaps them, then
  recreate the container with *Up*:

  ```yaml
  services:
    app:
      image: example/app
      init: true
  ```

  `init: true` fixes the reaping problem, not every possible cause, and takes
  effect only after the container is recreated. It is a service setting, so it
  is edited in that stack's Compose file like any other change.
