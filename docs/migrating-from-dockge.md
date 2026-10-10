# Migrating from Dockge

Dockge and Compose Panel both treat a stack as a folder with a Compose file, so
there is nothing to convert: you point Compose Panel at the same stacks folder,
stop Dockge, and your containers keep running throughout. Rolling back means
starting Dockge again.

This guide assumes Dockge's usual layout: Dockge itself in `/opt/dockge`, and
your stacks in `/opt/stacks` (its `DOCKGE_STACKS_DIR`). Adjust the paths if
yours differ.

## What stays the same

- **Your stacks.** Same folders, same `compose.yaml` and `.env` files, same
  containers, volumes and networks. Nothing is imported, nothing is rewritten.
- **Project names.** Dockge runs Compose from each stack folder, so a stack's
  project is usually named after its folder. Compose Panel does not assume
  that: it finds each stack's project by its Compose file path, which matches
  either way.
- **The `docker compose` CLI.** Every stack stays manageable from a shell, as
  before.

## What is different

| In Dockge | In Compose Panel |
| --- | --- |
| Interactive web terminal | None, on purpose. Use SSH and `docker compose exec`. |
| Agents (several Docker hosts in one UI) | One panel per host. |
| Create, convert (`docker run` → Compose) and delete stacks from the UI | Create a folder with a `compose.yaml` on the host and it appears. To delete a stack, use `Down`, then remove the folder. |
| Form-based Compose editor | Raw editor for `compose.yaml` and `.env`, checked with `docker compose config` before saving, with a backup on each save. |
| `global.env` shared by all stacks | Not supported: each stack uses its own `.env` (see below). |
| Update button | `Pull` shows which services have an update ready, from which version to which, before `Up` applies it. |
| Usually reachable on port 5001 | Always bound to `127.0.0.1`. Use an SSH tunnel, or HTTPS with Caddy on the same host. |
| Account database in `/opt/dockge/data` | One account configured by environment variables, no database. |

## 1. Check that your stacks are compatible

Compose Panel manages a folder only if it is unambiguous. Run this in the stacks
folder; it prints only the folders that need attention:

```sh
cd /opt/stacks
for dir in */; do
  name=${dir%/}
  files=$(ls -1A "$name" | grep -E '^(docker-)?compose\.ya?ml$' | xargs)
  overrides=$(ls -1A "$name" | grep -E '^(docker-)?compose\.override\.ya?ml$' | xargs)
  case "$name" in [!a-z0-9]*|*[!a-z0-9_-]*) echo "$name: name not supported (lowercase letters, digits, - and _, starting with a letter or digit)";; esac
  [ -L "$name" ] && echo "$name: symbolic link, not managed"
  [ -n "$overrides" ] && echo "$name: override file ($overrides), not supported yet"
  [ "$(echo $files | wc -w)" -eq 1 ] || echo "$name: needs exactly one Compose file (found: ${files:-none})"
done
[ -s global.env ] && echo "global.env found: see 'Stacks that use global.env'"
```

Folders it reports are left out of the panel (or refused with an explanation);
they keep running and stay manageable from the CLI. To bring them in:

- **Name:** rename the folder only after `docker compose down` in it, since a
  new folder name usually means a new project name. Or set `name:` in the
  Compose file to keep the old project name.
- **Override file or several Compose files:** merge them into one
  `compose.yaml`, or keep managing that stack from the CLI.
- **Symbolic link:** replace it with the real folder.

### Stacks that use `global.env`

Dockge can pass a shared `global.env` to every stack. Neither the plain
`docker compose` CLI nor Compose Panel reads it, so a stack that relies on it
fails validation (missing variables) in the panel. For each such stack, copy
the variables it uses from `global.env` into its own `.env`, then check from a
shell:

```sh
cd /opt/stacks/<stack> && docker compose config --quiet && echo ok
```

## 2. Back up

```sh
sudo tar -czf ~/stacks-before-compose-panel.tgz -C /opt stacks
sudo tar -czf ~/dockge-data.tgz -C /opt/dockge data
```

Neither panel deletes stacks on its own, but this is the rollback if anything
goes wrong.

## 3. Install Compose Panel

Follow [deployment.md](deployment.md). The one thing to get right: the stacks
folder must be mounted at **the same path** inside and outside the container,
and `STACKS_DIR` must be that path. The provided `deploy/compose.yaml` already
uses `/opt/stacks:/opt/stacks`, Dockge's default.

You can start it while Dockge is still running, to look around: browsing is
read-only. **Do not run actions or save files from both panels at the same
time**: each one only knows about its own operations in progress.

Check that every stack is listed with its real status. A stack shown as
`unknown` usually means the stacks path seen by the panel differs from the one
Dockge used (`/opt/stacks` versus a different mount), so Docker's records do
not match the files.

## 4. Stop Dockge

```sh
cd /opt/dockge && docker compose stop
```

This stops only the Dockge container. Your stacks keep running. Use `stop`,
not `down`, for now: it keeps Dockge ready for a rollback.

If Dockge was reachable from outside (a `5001:5001` port mapping, or a proxy
site pointing to it), that access is now closed. If it was exposed directly on
port 5001, also close that port in your firewall or cloud security rules:
Docker port mappings bypass host firewalls such as `ufw`.

## 5. Reach Compose Panel

- **SSH tunnel:** `ssh -L5081:127.0.0.1:5081 you@host`, then open
  `http://127.0.0.1:5081`.
- **HTTPS without a tunnel:** point your Caddy site at the panel instead of
  Dockge, as described in
  [Behind Caddy](deployment.md#behind-caddy-https). With caddy-docker-proxy,
  move the `caddy` labels from Dockge's compose file to the panel's.

Then, for each stack: open it, check its services, and follow its logs once.
Running `Pull` on a stack shows whether newer images are waiting, without
touching it.

## 6. Clean up

After a few days without needing Dockge:

```sh
cd /opt/dockge && docker compose down
```

`/opt/dockge/data` holds Dockge's account database. Keep the backup from step 2
if you want, then delete the folder.

Compose Panel keeps its own files in `/opt/stacks/.compose-panel/` (save
backups and the activity log). Dockge ignores that folder.

## Rolling back

```sh
docker compose -f /path/to/compose-panel/deploy/compose.yaml stop
cd /opt/dockge && docker compose start
```

There is nothing to convert back: the stacks folder is still the one Dockge
knows. Files you edited in Compose Panel stay edited; the previous versions are
in `/opt/stacks/.compose-panel/backups/<stack>/`. If you moved variables from
`global.env` into stack `.env` files, both now hold them, which Dockge accepts.
