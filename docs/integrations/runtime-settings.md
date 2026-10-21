# Runtime settings through `.env` — PHP and Bun pattern

Changing a PHP directive or a Bun setting should not mean an SSH session, a
`docker exec` into a running container, or a rebuilt image. This page shows a
Compose convention that makes the common settings editable from the panel's
existing `.env` editor and applied with **Up**, with no runtime-specific code in
the panel.

> This is a convention for your stacks, not a panel feature. The panel has no
> knowledge of PHP or Bun: it edits `.env`, validates the project with
> `docker compose config`, and recreates the service when asked. The stack stays
> fully manageable with `docker compose` alone.

Use it to apply a **mitigation** quickly (for example disabling a PHP feature
while a fix is pending). A mitigation does not replace updating the runtime
itself: pull or rebuild the image as soon as a fixed version exists.

## Which path applies to you

| Your stack | What to do | Host access needed |
| --- | --- | --- |
| **Prepared**: `zz-runtime.ini` is mounted and the variable is listed under `environment:` | Edit `.env`, save, **Up** ([section 4](#4-applying-a-change)) | No |
| **Not prepared**, and the mitigation is needed now | Add a launch flag in `compose.yaml`, save, **Up** ([section 5](#5-in-an-emergency-on-a-stack-that-was-not-prepared)) | No |
| **Not prepared**, no urgency | Prepare it once ([section 2](#2-php)), then use section 4 from then on | **Yes, once** |

Prepare stacks before you need them: on the day of an incident, the
preparation step is the one thing the panel cannot do for you.

## 1. How it fits together

```text
.env (edited in the panel)
  │  Compose interpolation
  ▼
compose.yaml  environment: PHP_UPLOAD_PROGRESS: ${PHP_UPLOAD_PROGRESS:-On}
  │  container environment
  ▼
zz-runtime.ini (bind-mounted, read-only)
  session.upload_progress.enabled = ${PHP_UPLOAD_PROGRESS}
  │  PHP reads the ini file at startup and expands ${...}
  ▼
active PHP setting
```

- `.env` alone changes nothing in PHP: it only feeds Compose. The variable must
  be passed to the container (`environment:`) **and** read by an ini file.
- Defaults live in `compose.yaml` (`${VAR:-default}`), so a missing `.env` entry
  never produces an empty directive.
- Only the listed variables reach the container. Prefer `environment:` over
  `env_file: .env`, which would copy every `.env` value — secrets included —
  into the container environment.
- A changed value changes the service's Compose configuration hash, so **Up**
  recreates exactly the services concerned.

## 2. PHP

> **Prerequisite, done once outside the panel.** The panel edits only
> `compose.yaml` and `.env`; neither the editor nor **New stack** can create
> `php/zz-runtime.ini`. Create it on the host (SSH, SFTP, or your deployment
> tool) **before** referencing it in `compose.yaml`: with
> `create_host_path: false`, **Up** fails while the file is missing.

`php/zz-runtime.ini`, next to `compose.yaml`:

```ini
; Values come from the container environment, set in compose.yaml.
; Keep only directives you actually want to manage from .env.
session.upload_progress.enabled = ${PHP_UPLOAD_PROGRESS}
session.use_strict_mode = ${PHP_SESSION_STRICT}
memory_limit = ${PHP_MEMORY_LIMIT}
upload_max_filesize = ${PHP_UPLOAD_MAX_FILESIZE}
post_max_size = ${PHP_POST_MAX_SIZE}
display_errors = ${PHP_DISPLAY_ERRORS}
```

`compose.yaml` (this part can be edited in the panel once the file exists):

```yaml
services:
  app:
    image: php:8.4-fpm
    environment:
      PHP_UPLOAD_PROGRESS: ${PHP_UPLOAD_PROGRESS:-On}
      PHP_SESSION_STRICT: ${PHP_SESSION_STRICT:-1}
      PHP_MEMORY_LIMIT: ${PHP_MEMORY_LIMIT:-256M}
      PHP_UPLOAD_MAX_FILESIZE: ${PHP_UPLOAD_MAX_FILESIZE:-16M}
      PHP_POST_MAX_SIZE: ${PHP_POST_MAX_SIZE:-16M}
      PHP_DISPLAY_ERRORS: ${PHP_DISPLAY_ERRORS:-Off}
    volumes:
      - type: bind
        source: ./php/zz-runtime.ini
        target: /usr/local/etc/php/conf.d/zz-runtime.ini
        read_only: true
        bind:
          create_host_path: false
```

`.env`, only for the values that differ from the defaults:

```dotenv
PHP_UPLOAD_PROGRESS=Off
```

Notes:

- **The target directory depends on the image.** `/usr/local/etc/php/conf.d/`
  is scanned by the official `php` images (`$PHP_INI_DIR/conf.d`). Other images
  (distribution packages, FrankenPHP, vendor images) use other paths: check
  `php --ini` in the image before relying on it.
- **`zz-` sorts last**, so these values override earlier files in the same
  directory. Directives set elsewhere still win: an FPM pool
  `php_admin_value` / `php_admin_flag`, an Apache `php_value`, or `ini_set()`
  in the application. If a pool file sets the directive, change it there.
- **`create_host_path: false`** makes `up` fail when the file is missing,
  instead of Docker silently creating a directory in its place.
- **Environment expansion in ini files** (`${VAR}`) is supported by all current
  PHP versions. PHP-FPM parses the ini files in its master process, which
  inherits the container environment, so `clear_env` (which only affects
  worker `$_ENV`) does not get in the way.
- The panel validates the Compose project, not PHP values. A typo such as
  `PHP_MEMORY_LIMIT=256 M` passes validation; PHP then logs a warning and may
  fall back to its default. Check the container logs after applying.

## 3. Bun

Bun reads its environment directly, so the ini step disappears and no host
file is needed. Pass only the variables the application or Bun actually reads:

```yaml
services:
  api:
    image: oven/bun:1
    environment:
      NODE_ENV: ${NODE_ENV:-production}
      MAX_UPLOAD_BYTES: ${MAX_UPLOAD_BYTES:-10485760}
```

Settings that live in `bunfig.toml` or in launch flags (`command:`) are part of
the image or of `compose.yaml`; edit them there.

## 4. Applying a change

1. **Edit and save.** Open the stack, edit `.env` (or the defaults in
   `compose.yaml`) and save. The panel validates the project and backs up the
   previous version (ADR 0004). Saving changes nothing in the running
   containers.
2. **Look at the Services table.** Services whose configuration changed are
   marked **Recreate pending** (ADR 0032).
   **No marker does not mean "nothing to apply"**. The marker is only shown
   with Compose 5.5.0 or later, never for a service that uses
   `network_mode`, `ipc` or `pid: service:…` or `volumes_from`, and not
   whenever the panel cannot read the state. If you changed a value the
   service uses, run **Up** anyway: it recreates only what changed and leaves
   the rest as it is.
3. **Run Up.** Use **Up** on the service from the Services table
   ([ADR 0021](../adr/0021-targeted-service-operations.md)): it recreates only
   that service and leaves the others, including its dependencies, untouched.
   Use **Up** on the whole stack when several services share the variable.
4. **Expect a short interruption.** Up stops the old container and starts a
   new one. With a single instance, requests fail for the few seconds this
   takes; schedule accordingly.
5. **Check the active value** ([section 6](#6-checking-the-active-value)). The
   **Recreate pending** marker should be gone.

**Use Up, not Restart.** `docker compose restart` restarts the *existing*
container with its *old* environment: a changed `.env` value is ignored until
the container is recreated. Editing the bind-mounted ini file itself (on the
host) is the one case where **Restart** is enough, because the file is re-read
at startup.

## 5. In an emergency, on a stack that was not prepared

When the mitigation is needed now and the stack has no `zz-runtime.ini`, set
the directive as a PHP-FPM launch flag. This needs only `compose.yaml`, so it
can be done entirely from the panel:

```yaml
services:
  app:
    image: php:8.4-fpm
    command: ["php-fpm", "-d", "session.upload_progress.enabled=Off"]
```

Save, then **Up** on the service, as in section 4 (the change is in
`compose.yaml`, so the configuration hash changes the same way).

Check these before relying on it:

- **`command:` replaces the image's default command.** It is only correct if
  the image normally starts `php-fpm` itself, as the official `php:*-fpm`
  images do. If the image's command already has flags, keep them and add
  `-d …` after them. For another image, read its documentation or run
  `docker image inspect --format '{{json .Config.Cmd}}' <image>` on the host.
- **It does not apply to every PHP image.** `php:*-apache` (mod_php,
  `apache2-foreground`), FrankenPHP and images whose entrypoint starts several
  processes ignore `php-fpm -d`. For those, prepare the stack (section 2).
- **Pool settings still win.** A pool `php_admin_value` / `php_admin_flag` for
  the same directive overrides `-d`.
- **It is temporary.** Once a patched image is deployed, remove the
  `command:` line and run **Up** again, or move the stack to the prepared
  pattern so the next change is a `.env` edit.

## 6. Checking the active value

Prefer a check that asks the running application, not only the configuration.
With the [application toolbox](../adr/0026-application-toolbox.md), a project
can expose a read-only check next to its other scripts:

```json
{
  "scripts": {
    "runtime:check": "php -r \"foreach (['session.upload_progress.enabled', 'memory_limit'] as \\$k) { echo \\$k, ' = ', var_export(ini_get(\\$k), true), PHP_EOL; }\""
  },
  "extra": {
    "compose-panel": {
      "version": 1,
      "actions": {
        "runtime:check": { "label": "Show active PHP settings" }
      }
    }
  }
}
```

Reading the result for an on/off directive: `'1'` means **On**; `''` or `'0'`
means **Off**. `false` means the directive does not exist in this PHP build.

This runs the **CLI** binary in the same container. With the official images
the CLI and FPM read the same `conf.d` files, but launch flags (section 5) and
FPM pool or web server overrides only apply to web requests: after an
emergency `command:` change, the CLI still reports the old value. For a
definitive answer, expose the values through an authenticated or
internal-only route of the application. Never publish `phpinfo()`.

If the value did not change after **Up**:

- the container was not recreated (the **Recreate pending** marker is still
  there, or the container's creation time predates the save): run **Up** on
  the service again;
- the variable is set in `.env` but not passed under `environment:`;
- the ini file is not mounted where this image reads it (`php --ini`);
- a pool or web server setting overrides it (section 2, notes).

## 7. What this pattern does not do

- It does not update PHP or Bun. Security fixes need a newer image: **Pull**
  then **Up** for registry images
  ([ADR 0011](../adr/0011-pull-and-update-ready.md)); a rebuild for locally
  built images (`docker compose build --pull` on the host for now).
- It does not edit files inside a running container. Changes made with
  `docker exec` are lost when the container is recreated and are not part of
  the stack's history.
- Inline Compose `configs:` with `content:` would avoid the extra file, but a
  changed `content` does not change the service's configuration hash
  (verified with Compose 5.6), so **Up** may not recreate the container. Stay
  with `environment:` + a bind-mounted file.
