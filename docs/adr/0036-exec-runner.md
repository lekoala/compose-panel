# ADR 0036 — Exec runner for application actions

Status: accepted

## Context

[ADR 0026](0026-application-toolbox.md) launches every application action
through a package manager: `composer run-script`, `npm run` or `bun run`. The
image must therefore ship that tool on its `PATH`.

Production images are often built in several stages: Composer, npm or Bun
install the dependencies in a build stage and are left out of the final image.
For such an image, adding a package manager only so the panel can call it adds
weight and attack surface, and the script it would run is usually a single
command anyway (`php bin/console …`, `node scripts/…`).

ADR 0026 launches the runner rather than the extracted script body in order to
keep the tool's semantics: Composer's `@other` references and callbacks, npm's
`pre<name>`/`post<name>` hooks. An action that names its command directly has
none of those to keep.

## Decision

Add a fourth runner, `exec`. Its actions carry their own fixed command, which
the panel runs with `docker exec`, with no package manager and without adding
a shell.
The trusted manifest can explicitly name an interpreter, including `sh -c`;
the panel does not prohibit interpreters or inspect the program's behavior.

### Stack configuration

An `exec` source names the manifest that declares its actions, because the
runner does not imply one:

```yaml
x-compose-panel:
  toolbox:
    sources:
      - id: app
        service: web
        runner: exec
        manifest: composer.json # or package.json
        workdir: /app
```

`manifest` is required for `exec` and accepts only `composer.json` or
`package.json`, read from the same place as before (the `workdir`, else the
container's working directory). A script runner implies its manifest, so
`manifest` on a `composer`, `npm` or `bun` source is a configuration error.

### Manifest

The `compose-panel` section and its schema version stay the same. Under `exec`,
every action declares `command`, a list of 1-16 non-empty strings without NUL
bytes whose first item does not start with `-`:

```json
{
  "extra": {
    "compose-panel": {
      "version": 1,
      "actions": {
        "world:reset": {
          "label": "Reset the demo world",
          "confirmation": "Erase this environment's data and reseed it?",
          "command": ["php", "bin/console", "app:world:reset", "--no-interaction"],
          "timeout": 300
        }
      }
    }
  }
}
```

One style per source, so no declaration is ambiguous:

- under `exec`, an action without a valid `command` is a configuration error,
  and the action does not need an entry in `scripts`;
- under a script runner, an action that declares `command` is a configuration
  error; the ADR 0026 rules (matching, runnable `scripts` entry) are unchanged.

### What stays the same

Everything else in ADR 0026 applies unchanged: declaration is authorization,
the browser sends only identifiers, the action identifier keeps its grammar,
the service must have exactly one running container, the manifest is read
with the bounded `docker cp` stream ([ADR 0029](0029-bounded-manifest-transfers.md)),
execution revalidates under the per-stack lock and pins the container, and
`docker exec` runs with no TTY, no stdin and no `--privileged`.

The catalog revision now also covers the manifest file and each action's
command, so a command edited between display and launch refuses the run.

## Consequences

- An image needs only the program its commands call, not a package manager.
- Security is unchanged in kind: the commands are part of the trusted manifest,
  exactly as script bodies already were. The panel never adds to a command and
  never takes one from the request.
- A project choosing `exec` gives up Composer's and npm's script features
  (references, hooks, callbacks) for those actions.

## Alternatives considered

- **Install the package manager in the image.** Works today, but makes every
  production image carry a tool it does not otherwise need.
- **Declare actions in image labels** read with `docker inspect`. Works even for
  an image without any file, but writing JSON in Dockerfile labels is awkward
  and it adds a second discovery path beside the manifest read.
- **A framework-specific runner** (for example `php bin/console <name>`). Simpler
  to declare, but `exec` covers it and every other case with one rule.
- **Run Composer script bodies without Composer** by recognising
  `@php bin/console …`. Fragile, and a partial reimplementation of Composer.

## Verification

`tests/toolbox.test.ts` covers the `manifest` field (required for `exec`,
refused elsewhere, limited to the two manifest names), the command grammar
(missing, string, empty, empty part, option-like executable, non-string part,
NUL byte, more than 16 parts), the refusal of `command` under a script runner,
the argv built for each runner, and a revision that changes with the command and
the manifest file. `tests/toolbox-app.test.ts` runs an `exec` action end to end
and checks that the executed argv is the declared command, whatever extra field
the request carries.

The route tests also change only `command` between the pre-check and locked
revalidation and assert refusal without an exec. `tests/toolbox-linux.test.ts`
reads a Composer manifest without scripts from an Alpine container lacking
Composer, npm and Bun, then executes its declared command and verifies that
spaces and shell metacharacters remain literal arguments.

Manual verification before release: on a development machine or disposable VM,
run `bun run test:docker-lab:wsl tests/toolbox-linux.test.ts` (Windows), or
`bash scripts/docker-lab/run.sh tests/toolbox-linux.test.ts` (Linux). Use only
the guarded disposable daemon, never a host daemon running real stacks. In the
panel, verify an exec action on a disposable stack with no package manager,
its confirmation and streamed outcome, and refusal after editing its command
without reloading the page.

Verification on 2026-11-09: the guarded Docker lab suite passed through WSL
(5 tests), including the Alpine exec case. The Windows suite passed with 870
tests and 234 skips; typecheck and formatting checks passed. The browser
checklist above remains pending.
