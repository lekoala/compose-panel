# CI — pipeline

The pipeline lives in `.github/workflows/ci.yml` (Linux runners, Bun 1.4.3
pinned): `bun install --frozen-lockfile`, `bun audit`, `bun run typecheck`, `bun run test`,
then a pinned image build, a socket-less smoke test (reads and auth
only, no Docker socket mounted) and Trivy scans that fail on CRITICAL/HIGH.
PR builds never publish images. The workflow also runs weekly on the default
branch, so new fixable CVEs and expired exceptions fail without a push.

Scans: a filesystem scan covers dependencies and secrets
(`scanners: vuln,secret`, skipping `node_modules`/`private`/`.git`), and the
built image is scanned separately. Both gate on `CRITICAL,HIGH`. The image scans
(CI and release) skip CVEs that have no fix published (`ignore-unfixed`): most
come from Debian base packages and no update can remove them. Every fixable
finding still fails the build unless `.trivyignore.yaml` lists it with a
reason, the exact path and an `expired_at` date; past that date the entry stops
applying and the scan fails again. Remove an entry as soon as a pinned version
carries the fix. The image installs no `gnupg` (apt reads the `.asc` key
directly), to keep unused packages and their CVEs out. The build runs no
`apt-get upgrade`: Debian fixes arrive through deliberate base digest
refreshes, not as a side effect of the build date. The base image
is pinned by version and multi-arch digest in the `Dockerfile`, and every GitHub
Action is pinned to a full commit SHA (with the human tag in a comment). Bump
them deliberately and re-run the smoke checklist when you do.

Update tracking: Dependabot (`.github/dependabot.yml`) proposes base image
digest refreshes for the pinned Bun tag; the `FROM` reference is written
literally because Dependabot does not resolve `ARG` values in `FROM`. Bun
version bumps stay manual (Dockerfile `FROM` and `base.name` label, workflow
`bun-version`). Docker CLI and Compose come from apt and the Compose release
page, which Dependabot cannot track: check for a new Compose release before
the earliest `expired_at` in `.trivyignore.yaml`, and bump
`DOCKER_COMPOSE_VERSION` with the CI `COMPOSE_VERSION`/`COMPOSE_SHA256`.

Reproducibility: the base image and Docker tooling versions are pinned and
builds are security-scanned, but exact byte-for-byte reproducibility is not
guaranteed (apt resolves `ca-certificates` and `curl` at build time).

Image metadata: the runtime stage carries OCI `org.opencontainers.image.*`
labels (title, description, url, source, licenses, vendor, version, revision).
`VERSION`/`REVISION` are passed as build args from CI (`package.json` version and
`GITHUB_SHA`) and default to `dev`/`unknown` for a local build; no timestamp
is added. There is **no OCI icon
field** — a registry logo (e.g. the GHCR package or Docker Hub repository
avatar) is configured on the registry side, not from the image. The panel's own
favicon/logo ship in `public/` and are served by the app.

Dependency audit: `bun audit` runs on every build (baseline 2026-10-10: no
vulnerabilities, 4 packages). Fix advisories with deliberate version bumps,
regenerate the lockfile and re-run `bun run verify`; never rewrite ranges
blindly (`bun audit fix -L` needs the same review as a dependency change).
`@types/bun` is type-only and stays one minor behind the runtime until
`@types/bun@1.4.3` is published. The production-only boot step proves the
server starts with devDependencies stripped (`bun install --production`,
`node_modules/@types` asserted absent, `/health/live` reachable).

`tests/process-linux.test.ts` runs automatically on Linux: disposable Bun
children exercise a real provider subprocess, split UTF-8, abort and timeout
escalation against a child ignoring `SIGTERM`, including a plugin-like child
inheriting the CLI parent's pipes and process group. The provider executable is a
clearly marked fixture; these tests never invoke Docker or access a daemon.
Browser fixtures verify that operation/log text fragments survive SSE insertion.

The test job also runs `tests/compose-config-linux.test.ts` with
`COMPOSE_PANEL_TEST_COMPOSE_CONFIG=1`: real `compose config` resolves project
names from the directory, YAML, `.env` and process environment. Project discovery
is stubbed and every real command is restricted to `config`; no daemon access or
resource mutation occurs. CI first installs the same Compose plugin version as
the image (checksum pinned in the workflow), so the test exercises the version
that ships; bump it together with `DOCKER_COMPOSE_VERSION` in the `Dockerfile`.
A preflight `config` call reports the exit code, timeout and stderr of a failing
Compose (fixture data only) instead of a bare test timeout. Run the same command
manually on Linux with the installed Compose CLI. The ordinary test suite skips this opt-in check.

## Disposable-daemon integration (opt-in)

The read-only Docker integration test (`tests/docker-integration.test.ts`)
runs only with `COMPOSE_PANEL_TEST_DOCKER=1`, on a disposable isolated daemon
with secret-free fixtures — never on a production socket, never in
unattended CI.

## Publication (tags only)

Releases are published by `.github/workflows/release.yml`, triggered only by
a maintainer tag (`v*`), after the smoke test and review: build the Linux
image with Bun + Docker CLI + Compose plugin (pinned, verified with
`bun --version`, `docker --version`, `docker compose version`), scan it, push
immutable version tags plus `latest` to GHCR.

## Deployment
Keep the build and deployment steps separate. Publishing an image must **never** automatically update production stacks.
