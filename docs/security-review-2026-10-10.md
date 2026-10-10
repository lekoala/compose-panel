# Security review — 2026-10-10

> **Status (2026-10-10, after review):** SEC-01 to SEC-05 are fixed, each with regression tests that fail on the reviewed code (`tests/app.test.ts`, `tests/audit.test.ts`, `tests/auth.test.ts`, `tests/editor.test.ts`). Verification: Windows 274 passed / 15 skipped; Linux (WSL) 288 passed / 1 skipped (real-daemon test); typecheck clean; the review probes rerun on Linux, including real Compose `config` with a multiline secret, now redact or refuse. The "Other observations" below remain open. The text below is the original review, unchanged.

Reviewed revision: `73f8624`, with an initially clean working tree. This is a source review and isolated verification, not a production penetration test. Application code was not changed and the findings below remain open.

Scope note: concurrent time-zone changes appeared in `src/config.ts` and `src/html.ts` while the report was being completed. They were not made or reverted by this review. Test results below apply to the inspected snapshot before those changes; they do not certify the final concurrent working tree. Source line references refer to that snapshot.

## Result

Five actionable findings were reproduced. No unauthenticated takeover, shell injection, or browser script execution was demonstrated. The existing single-trusted-administrator threat model still applies: permission to edit and deploy Compose already grants extensive host control.

Priority reflects that threat model. P2 means a correction is warranted; P3 means a narrower defect or hardening opportunity. A passing suite does not cover the new cases below.

## Findings

### SEC-01 — Pending mutations outlive session revocation (P2)

Locations: `src/app.ts:870`, `src/app.ts:532`, `src/app.ts:584`, `src/app.ts:615`.

The authenticated session is read before the request body. Save and operation handlers receive only its CSRF string. They do not recheck that the session is still active after reading the body or after asynchronous project discovery. Event streams already have such a recheck.

Reproduction with the real application handler and a fixture provider:

1. Sign in and obtain the session cookie and session CSRF token.
2. Start a POST to `/stacks/demo/operations`, leaving its body stream pending.
3. Log out successfully in a second request.
4. Finish the pending body with the former CSRF token and `action=stop`.

Observed: logout returns 303, the pending action also returns 303, and the provider receives one stop call. The action had not passed its body/CSRF check when logout completed. This is separate from allowing an already-started operation to finish.

Impact is conditional on an initially valid session and CSRF token. It does not let an unauthenticated visitor create a session. A stolen session can retain a pending request beyond revocation; expiry has the same missing recheck by inspection. The reproduction exercised `app.fetch`, not a slow upload through a production proxy.

Correction: pass the session identity to mutation handlers and revalidate it without refreshing activity before accepting the save or starting the operation, after the relevant awaited work. Preserve the documented continuation of already-accepted work. Add delayed-body and delayed-discovery revocation/expiry tests.

### SEC-02 — Audit paths follow existing directory symlinks (P2)

Locations: `src/audit.ts:242`, `src/audit.ts:272`, `src/audit.ts:289`.

`ensureDir()` creates the directory recursively and checks only the final component. An existing `.compose-panel` symlink is followed. Reading periods also does not validate directory components. `O_NOFOLLOW` on the log file only protects the final file component.

Linux reproduction: make `<temporary-root>/.compose-panel` a symlink to another temporary directory and record an event using the default audit layout. The log is created in the other directory, and `readPeriod()` reads it successfully. No race is required. Retention subsequently operates through that same path.

This requires local permission to alter the directory hierarchy, or a pre-existing unsafe layout. It is not a remote file-write primitive by itself. It violates the documented symlink boundary and can redirect privileged writes, chmod operations, and retention outside the intended audit tree.

Correction: check managed directory components before creation and before reads/pruning, following the existing backup-directory approach. Cover parent symlinks and a symlinked final directory for read-only access. Continue documenting the remaining privileged-local-writer race assumption.

### SEC-03 — Validation errors can disclose secret fragments (P2)

Locations: `src/editor.ts:70`, `src/editor.ts:129`, `src/editor.ts:188`, `src/docker.ts:70`.

Three cases were reproduced:

- Overlapping values are replaced in input order. With `SHORT=abcd` and `LONG=abcd-sensitive-suffix`, redacting the long value produces `***-sensitive-suffix`.
- The subprocess runner truncates stderr before the editor sees it. With a synthetic secret crossing that cap, `validateDraft()` returns `error: synthetic-sec`. Redaction before the editor's own display truncation does not address this earlier cap.
- The collector splits `.env` into individual lines. Real Compose config validation with `TOKEN='firstline\nlast-secret-line'` (an actual newline inside the quoted value) and an invalid port returns `invalid containerPort: ***\nlast-secret-line`.

The multiline case used Compose v5.5.1 with `config` only. Docker documents multiline quoted values in its [interpolation reference](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

These messages are shown to the authenticated administrator, who already has access to the editor. No unauthenticated disclosure or application-log leakage was demonstrated. The defect matters to the explicit promise that validation diagnostics do not reveal `.env` values, including during screen sharing or diagnostic copying.

Correction: redact longest values first, handle supported multiline/interpolated forms, and avoid displaying raw truncated diagnostics whose complete secret values are unavailable. A fixed safe message is preferable when complete redaction cannot be established. Add tests at both runner and display boundaries with synthetic secrets.

### SEC-04 — Audit retention deletes files other than logs (P2)

Locations: `src/audit.ts:190`, `src/audit.ts:289`.

Period listing and retention remove the final four characters of each filename and validate the remainder, without requiring a `.log` suffix. Pruning then unlinks the original filename.

Reproduction: put an unrelated `2000-01-01.txt` in a temporary audit directory, set retention to one file, and record a current event. The text file is deleted; only the current `.log` remains.

The normal dedicated audit directory limits the impact. A reused custom audit directory, or the redirected path in SEC-02, can contain unrelated data. This is unintended deletion, not a general remote deletion endpoint.

Correction: require the exact period-plus-`.log` filename and appropriate file type for enumeration and pruning. Verify that `.txt`, `.bak`, directories, and other unrelated entries survive retention.

### SEC-05 — Login tracking has no hard cardinality bound (P3)

Locations: `src/auth.ts:187`, `src/auth.ts:252`, `src/app.ts:362`.

Every new client key is inserted into the attempt map before global password-verification capacity is checked. The sweep only removes expired keys. Once 1,024 entries exist, every reservation scans the full map, including when none can expire. The eight-verification cap does not bound this storage or scanning work.

Reproduction: reserve and settle one failed attempt for each of 5,000 distinct synthetic IPv6 client keys within one window. All 5,000 remain. Growth is unbounded within the window and repeated insertion causes quadratic aggregate scan work. A full service-exhaustion attack was not run.

Remote exploitation requires many actual source addresses behind the supported proxy; forged earlier X-Forwarded-For entries do not suffice. Direct tunnel access shares a single key. The documented host-level defenses reduce this exposure.

Correction: add an explicit bound on tracked and pending keys and use bounded/amortized expiry work. Define capacity refusal without evicting active reservations or silently resetting existing throttles. Test admission under many distinct keys.

## Other observations and accepted limits

- **Inherited environment remains trusted input.** A real config-only probe with no stack `.env` and `COMPOSE_ENV_FILES` pointing to an external synthetic file resolved its project name while `ProjectContext.envFile` remained null. This follows ADR 0008's explicit inheritance policy and Docker's [documented fallback](https://docs.docker.com/compose/how-tos/environment-variables/envvars/). It is not an unauthenticated override. Do not interpret a null `envFile` as proof that Compose reads no environment file. Any move to restrict inherited inputs needs its own ADR.
- **Read-only status uses a weaker file context.** `loadStackDetail()` calls `projectServices()` and `projectImages()` without the `.env` verification used by mutations and log follows. Their provider signatures cannot carry a verified env file. This is a hardening gap to consider when unifying context handling; a daemon-level disclosure through these calls was not demonstrated.
- **CI production-only boot is misconfigured by inspection.** `.github/workflows/ci.yml` supplies the password hash but no unique `COMPOSE_PANEL_ADMIN_USER` for this step. `loadConfig()` rejects the default `admin` without development mode. Set a fixture administrator name so this gate can exercise the intended boot. The release workflow independently scans the image but does not run or depend on the test job.
- **Image and deployment were not re-certified.** No application image was built or scanned in this review, no production proxy/firewall settings were inspected, and no Docker resources were created, stopped, or changed. Earlier deployment-checklist results are not new evidence for this review.
- **Existing trust limitations remain.** Filesystem point-in-time checks do not provide transactions against privileged local writers. Operations are not recovered after a crash. Docker/container output can itself contain secrets and remains restricted to authenticated views.

## Coverage and validation

Reviewed authentication and session handling; Origin/Host/CSRF controls; server rendering, browser JS and CSP; stack discovery and file editing; backup/rollback paths; project identity and provider arguments; subprocess environment, capture and termination; operation locks, SSE and logs; audit storage; configuration, deployment packaging, CI, and dependency lockfile.

| Verification | Result |
| --- | --- |
| `bun run test`, Windows, Bun 1.4.3 | 250 passed, 15 skipped, 0 failed |
| `bun run typecheck`, Windows | Passed, 41 files |
| Linux WSL suite, Bun 1.4.3 | 264 passed, 1 skipped, 0 failed |
| Linux typecheck | Passed, 41 files |
| Real Compose config integration, Linux | Passed, Compose v5.5.1; fixture discovery, no daemon access |
| Real Caddy TLS proxy suite | 14 passed, 0 failed; fixture Docker, Caddy 2.8.4 |
| `bun audit` | No reported vulnerabilities in four packages at review time |
| New synthetic audit probes | Reproduced SEC-01 through SEC-05 and the environment fallback |

The one Linux skip is the explicit real-daemon discovery test. Signal escalation, plugin-like child cleanup, symlinks, file modes, and stream revocation ran on Linux. Proxy checks covered Secure cookies, foreign Origin/Host refusal, forged forwarded addresses, incremental SSE, UTF-8, and logout closing open streams. These confirm existing protections; they do not fix the findings.

Local reproduction artifacts are retained under the ignored `private/` directory: `security-review-20261010.ts` and `security-proxy-20261010.sh`. The first uses temporary synthetic files, an application/provider fixture, and Linux Compose `config` only. The second ran the existing proxy suite in a fresh directory using its cached Caddy binary, with cleanup narrowed to its own process IDs. They are audit evidence, not committed regression coverage.

## Change and rollback report

- Summary: review and reproduction only; five open findings, no application fix claimed.
- Tracked files added by this review: this report only; concurrent application edits are outside this change.
- Behavior and failure/rollback behavior: unchanged; deleting this report reverts the tracked change.
- Dependency delta: none.
- Security considerations: all probes used synthetic credentials/data and isolated temporary files; no live Docker mutation was performed.
- Known limitations: no production penetration test, image vulnerability scan, real-daemon lifecycle test, or exhaustive distributed denial-of-service test. Corrections need dedicated regression tests and the existing project quality gates.
