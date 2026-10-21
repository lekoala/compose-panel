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

- Defaults live in `compose.yaml` (`${VAR:-default}`), so a missing `.env` entry
  never produces an empty directive.
- Only the listed variables reach the container. Prefer `environment:` over
  `env_file: .env`, which would copy every `.env` value — secrets included —
  into the container environment.
- A changed value changes the service's Compose configuration hash, so **Up**
  recreates exactly the services concerned.

## 2. PHP

`php/zz-runtime.ini`, next to `compose.yaml`, created once on the host:

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

`compose.yaml`:

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
  `php_admin_value`, an Apache `php_value`, or `ini_set()` in the application.
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

Bun reads its environment directly, so the ini step disappears. Pass only the
variables the application or Bun actually reads:

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

1. Edit `.env` (or the defaults in `compose.yaml`) in the panel and save. The
   panel validates and backs up the previous version (ADR 0004).
2. Run **Up** on the service concerned from the Services table
   ([ADR 0021](../adr/0021-targeted-service-operations.md)), or **Up** on the
   whole stack when several services share the variable.

The stack page marks services that **Up** would recreate with the current
configuration as "Recreate pending" (ADR 0032, Compose 5.5.0 or later).

Use **Up**, not **Restart**. `docker compose restart` restarts the existing
container with its old environment: a changed `.env` value is ignored until
the container is recreated. Editing the bind-mounted ini file itself (on the
host) is the one case where **Restart** is enough, because the file is re-read
at startup.

## 5. Checking the active value

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

This runs the **CLI** binary in the same container. With the official images
the CLI and FPM read the same `conf.d` files, but FPM pool or web server
overrides only apply to web requests. For a definitive answer, expose the
values through an authenticated or internal-only route of the application.
Never publish `phpinfo()`.

## 6. What this pattern does not do

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
