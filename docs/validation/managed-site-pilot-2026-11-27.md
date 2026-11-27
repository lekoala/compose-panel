# Managed-site pilot - real-host validation (2026-11-27)

This record closes the pilot gate in [roadmap.md](../roadmap.md). The
[deployment checklist](../deployment.md#remaining-real-host-validation) was run
on a disposable Hetzner VPS, not on a production host.

## Environment

- Ubuntu 26.04 LTS, 4 vCPU, 7.7 GiB RAM, 72 GiB disk, kernel 7.0.0-44.
- Docker 29.10.1, Docker Compose v5.8.0, Caddy with the installed systemd
  helper, panel reached over HTTPS behind the installer's Basic Auth.
- One public domain for the panel, one for a managed site and one for the Restic
  REST endpoint. All names, tokens and credentials were disposable.
- **Build under test:** a local image built from the checkout after the
  retention fix (`6ac4088`), the pointer/probe card (`f1e0982`) and the
  installer wait (`8d97ded`), tagged as the release reference so
  `setup-caddy.sh --production` and `doctor.sh --production` accept it. The
  published `ghcr.io/lekoala/compose-panel:latest` at the time (0.6.0,
  `ec86fb0`) predates the pilot and ignores the flag, so the published-image
  install path is **not** validated by this run.

## Checklist result

| # | Check | Result |
| --- | --- | --- |
| 1 | Installer, health, helper socket, Compose version | **PASS** |
| 2 | Flag, two sites, both PHP channels, ports, generated files, no drift | **PASS** |
| 3 | Domain through Caddy, HTTPS, redirect, trusted proxy chain | **PASS** |
| 4 | Baseline, two deploys, no-op, probed rollback, crash windows | **PASS** |
| 5 | Force-recreate the runtime, gateway recovers through Docker DNS | **PASS** |
| 6 | Detach domain, Down, Start, Stop, Restart, no stale reservation | **PASS** |
| 7 | Revoke the deploy key, fail closed, rotation | **PASS** |
| 8 | CI deploy through the reviewed TLS proxy | **PARTIAL** |
| 9 | Backup timer, accepted run, overdue, verifier revocation | **PASS** |
| 10 | Retention preview, off-panel comparison, prune, check, restore | **PASS** |
| 11 | Snapshot list, choose, restore, repository unchanged | **PASS** |
| 12 | Check repository against a full `restic check --read-data` | **PASS** |
| 13 | SQL backup and restore against a real MariaDB | **PASS** |

Eleven of the twelve deployment-checklist lines pass; point 8 is partial. The
SQL line was added by this run and also passed.

### Details that changed the code

- **Installer (1).** Two first runs failed on the dpkg lock held by
  `apt-daily-upgrade`. The installer now waits 900 s by default
  (`COMPOSE_PANEL_APT_LOCK_TIMEOUT`, 60-3600) and says so; it never stops an APT
  timer or removes a lock file.
- **Rollback and crashes (4).** A probed rollback was replayed, then the panel
  was killed before and after the pointer switch. After a crash, acknowledging
  an unconfirmed deploy repairs nothing; the card now shows the pointer, the
  probe and the exact host repair on every render. No operation was resumed or
  replayed.
- **Private Git (7).** A local `git-shell` account and a forced
  `git-upload-pack` key exercised the real adapter: wrong host pin, wrong client
  key and revoked key all failed closed in about a second with the active
  release unchanged; a rotated key worked.
- **Backup timer (9).** A real systemd timer drove the token endpoint. One run
  was accepted, overdue was reported when the timer was stopped, and deleting
  the verifier digest answered `401` without touching the site. Rotating the
  verifier answered `200` and a replayed nonce answered `409`.
- **Retention (10).** The first preview failed for two real reasons: `restic
  0.18` writes `"remove": null`, and snapshots carried the Restic container
  hostname, so every backup was its own group. The fix adds
  `--host <siteId>` and accepts `null` (an absent list is still an error). A
  pre-fix repository keeps the old groups and needs one manual
  `--group-by paths` prune.
- **SQL (13).** The documented read-only role also needs `EVENT` for the fixed
  `--events` dump. The `mariadb:11` image is not pre-pulled by the panel; a
  first SQL backup that must download it can exceed the operation budget.

### Point 8 remains partial

The CI deploy works on host loopback: `202` on the tested SHA, the exact SHA
served, status `200`, replayed nonce `409`, revoked verifier `401`. It does not
work through the installer's TLS entrypoint: Caddy puts Basic Auth on every
route, and Basic Auth and the Bearer token share the `Authorization` header, so
Caddy answers before the panel sees the request. A route exception is a
security decision and was not added. This is the known limitation documented in
[deployment.md](../deployment.md#trigger-a-deploy-from-ci).

## Docker cost per managed site

Ten panel-created sites (`load-01`..`load-10`, ports 41011-41020, `php-8.4`,
same public demo repository, baseline published, all serving) each ran one
`nginx:1.27-alpine` gateway and one `php:8.4-fpm-alpine` runtime.

| Measure | 1 site | 5 sites | 10 sites |
| --- | --- | --- | --- |
| containers | 2 | 10 | 20 |
| container RSS, idle | 13.5 MiB | 68.0 MiB | 139.1 MiB |
| host `used` memory delta, idle | - | - | 211 MiB |
| CPU, idle (30 s) | 0.35 % of one core | 1.88 % | 3.53 % |
| writable layer | 135 KiB | 660 KiB | 1.32 MiB |
| stack folder | 108 KiB | 540 KiB | 1.1 MiB |

- Under load (10 concurrent `ab -n 1000 -c 20` runs, one per site): 10 000
  requests, 0 failed, 2.66 s wall, about 3 977 req/s aggregate, 50.4 ms mean,
  2.56 cores of the 4 vCPU host, 146.5 MiB container RSS.
- Images are shared: `nginx:1.27-alpine` 74.5 MB and `php:8.4-fpm-alpine`
  139 MB. The per-site image delta is zero.
- A PHP update of the ten sites (one rebuilt image, applied with **Up** one site
  after another) left each site unavailable for 0.5-1.5 s, 139.7 s wall with a
  12 s verification pause per site, and every site recovered. The gateway was
  never stopped.
- Caveat: the demo application is trivial (no database query, no Composer, only
  the synthetic load), and the host also ran the panel, MariaDB, Restic and the
  two demo sites. Mutualising the runtime would save at most the ~9 MiB FPM
  part, not the gateway.

## Residual limits

- The published-image install path is not validated; this run used a local
  build. A release candidate must be pulled by digest and the installer rerun
  before that path is called validated.
- Point 8 (CI through the reviewed TLS proxy) is partial for the Basic Auth
  reason above.
- The Restic endpoint used in this run was on the same VPS, with the data under
  `/srv/restic`. It proves the contract, not offsite durability. The accepted
  operator paths are an independent endpoint or a provider snapshot of the host
  that is replicated off it; the panel cannot verify either.
- A pre-fix retention repository needs one manual `--group-by paths` prune.
- The Composer install runs as the staging-tree owner; the supported installer
  deployment runs the panel as root, so that is uid 0 inside a
  capability-dropped, read-only, network-limited container. This is containment,
  not an unprivileged Unix user.
