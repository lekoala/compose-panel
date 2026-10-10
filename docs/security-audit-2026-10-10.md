# Security audit — 2026-10-10

## Summary

The application has substantial security controls for its intended single trusted administrator and loopback-only deployment. This review found four actionable defects and two hardening gaps. No unauthenticated command execution or authentication bypass was demonstrated. This is not an assurance that such vulnerabilities are absent.

Prioritize login concurrency limits, stream revocation, and consistent `.env` safety checks. Keep the documented loopback-only deployment restriction until the proxy and Host contract has been reviewed.

Scope: all application TypeScript, browser JavaScript, authentication, filesystem helpers, Compose invocation and process management, relevant tests, Dockerfile, deployment and CI configuration. The required product, architecture, security and roadmap documents were read before the review. Severity below reflects the current local, single-admin threat model, not an assumed public deployment.

## Remediation status (2026-10-10)

- **A1 — fixed.** The attempt is reserved synchronously before password
  verification and a global in-flight cap bounds concurrent verifications;
  success releases only its own reservation. Regressions: `LoginRateLimiter`
  reservation tests and a 12-request concurrent `POST /login` burst.
- **A2 — fixed.** Streams are bound to their session id; logout closes them and
  the heartbeat closes an expired session's stream without refreshing idle
  activity. Regression: logout closes an open logs stream.
- **A3 — fixed.** Project-context resolution now applies the editor's `.env`
  safety rules; a symlinked/non-regular/oversized `.env` is refused (`409`)
  before any Docker call and a verified `.env` is passed with `--env-file`.
  Regressions: explicit `--env-file` present/absent and a Linux symlinked-`.env`
  refusal for both mutation and follow.
- **A4, H1, H2 — open.** Tracked for a later pass (H2 needs an ADR before the
  environment contract changes).

## Findings

### A1 — Medium: parallel login requests bypass the attempt limit

Location: `src/app.ts:224–234`; `src/auth.ts:137–165`.

`limiter.check()` runs before the asynchronous password verification. An attempt is recorded only after verification fails. Concurrent requests all pass the initial check before any failure is recorded. There is also no bound on in-flight password verifications.

Reproduction: with the default limit of five attempts, send twelve concurrent `POST /login` requests with a matching Origin and matching CSRF cookie/form value, a known username and twelve incorrect passwords. All twelve return 401; none returns 429. This was reproduced against `createApp.fetch` with a synthetic Argon2id hash and reduced memory cost, without a listening server. The production hashing cost was not stress-tested.

Impact: the promised five-attempt limit does not constrain a burst; concurrent expensive password work can consume CPU and memory. An attacker must be able to reach the HTTP endpoint. A matching login CSRF pair is not a substitute for login throttling because a direct HTTP client can obtain or supply that pair.

Recommendation: reserve an attempt synchronously before awaiting password verification, and cap in-flight verifications globally. Keep success/failure accounting separate from reservations so concurrent success does not erase outstanding failures. Add a regression that sends more concurrent requests than the configured limit and checks both response counts and the maximum number of verifications started.

### A2 — Medium: logout and session expiry do not revoke existing SSE streams

Location: `src/app.ts:416–458`, `src/app.ts:597`, `src/app.ts:621`.

Authentication is checked when opening a stream. The stream retains no session reference and its heartbeat only sends a comment. Logout deletes the session but does not close its subscriptions. Absolute and idle expiration are likewise not checked during an established subscription.

Reproduction: authenticate, open `/stacks/demo/logs/events`, consume its replay, then log out successfully (303). Emit a synthetic log message from the provider after logout. The original stream still receives it. This was reproduced with the actual application routing and a controlled provider, without a Docker subprocess.

Impact: an already-open stream, including one opened with a stolen session, retains access to subsequent sensitive output after revocation. Default stream and follow timeouts limit this to their remaining lifetime, up to approximately thirty minutes; this is not indefinite access. New requests still require a valid session.

Recommendation: bind subscriptions to session IDs and close them on destruction and expiry. Use an expiry check that does not itself refresh idle activity. Closing an operation observer must continue to leave the operation running. Closing the final log observer should retain the existing follow-process cleanup. Add logout and expiry tests for both stream types.

### A3 — Medium: mutation and log paths omit the editor's `.env` safety checks

Location: `src/status.ts:107–137`; `src/compose-provider.ts:101–139`, `src/compose-provider.ts:164–182`; compare `src/editor.ts:195`.

The editor calls `readFileSafe()` on `.env` and rejects symlinks, non-regular files and oversized input. Project context resolution checks the Compose file but never checks `.env`. Project-name resolution, mutations and log follows then let Compose discover environment inputs implicitly; no verified `--env-file` is provided for those calls.

Impact: a stack rejected by the editor because of a symlinked `.env` can still reach Docker operations that read that file. A local writer able to change the stack directory can redirect interpolation to another readable file, or supply unbounded/non-regular input to the CLI. This does not grant an ordinary unauthenticated HTTP client filesystem access. A malicious trusted administrator already has host-level authority through Compose; the finding concerns the explicitly promised file boundary and inconsistent validation.

Evidence: confirmed missing validation through code review. An attempted Windows symlink fixture failed with `EPERM`; the end-to-end symlink behavior was not reproduced in this environment and must be tested on Linux. Docker documents implicit `.env` discovery when no explicit environment file is supplied: [Compose interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

Recommendation: validate the full environment context before all relevant CLI calls through the existing provider boundary. Define explicit behavior for an absent `.env`, reject unsupported environment overrides, and revalidate before mutation while holding the stack lock. Pass the verified input explicitly. Add an isolated Linux test with a symlink pointing to synthetic data and assert refusal before a mutation subprocess starts. Do not claim this eliminates every race with a privileged local writer.

### A4 — Low: validation-error redaction leaks valid `.env` values and secret prefixes

Location: `src/editor.ts:70–96`, `src/editor.ts:133–135`.

The custom secret collector does not implement the `.env` grammar. For `TOKEN=audit-secret # comment`, it records `audit-secret # comment`, so a diagnostic containing the actual value `audit-secret` is not redacted. Quoted/multiline and interpolated values also require more than line splitting. Independently, diagnostics are truncated before redaction: a secret crossing the 1,000-character boundary is reduced to a prefix that can no longer match the complete secret.

Reproduction: `redactSecrets('invalid audit-secret', collectSecrets('TOKEN=audit-secret # comment'))` returns the original secret. A controlled validation provider returning 992 `x` characters followed by `audit-secret` produces an error ending in `audit-se`. Both behaviors were reproduced with synthetic values. The inline-comment interpretation agrees with [Docker's `.env` syntax](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#env-file-syntax).

Impact: the documented promise of masked validation errors is unreliable. These errors are shown to an authenticated administrator who already has access to the editor, so this is not a demonstrated unauthenticated disclosure or application-log leak. It matters when errors are copied, screenshotted or later reused in logging.

Recommendation: prefer generic validation errors unless a diagnostic can be safely classified. If retaining redaction, handle supported value syntax and expanded values, redact before truncation, and test boundary truncation. Do not parse and rewrite the saved `.env` content.

## Additional hardening gaps

### H1 — Low: same-origin checking is not a trusted Host allow-list

Location: `src/app.ts:122–146`; `src/app.ts:555` onward.

Without `publicOrigin`, the expected origin is derived from the request's Host. There is no independent Host allow-list on GET or POST. A fixture request with `Host: attacker.invalid:5081`, a matching Origin and valid fixture credentials successfully logs in (303). This demonstrates acceptance of an unexpected Host, not an authentication bypass. With `publicOrigin`, mutation origins are pinned, but Host itself is still not validated.

Recommendation: allow only the configured loopback authorities and explicitly configured public authority, validating Host before routing. This adds protection against DNS rebinding and proxy misrouting. Auth and cookie scoping currently prevent concluding that DNS rebinding alone grants access to an existing administrator session. Add tests for unexpected Host values with both matching and mismatching Origin values.

### H2 — Medium operational risk: Compose inherits the panel's entire environment

Location: `src/docker.ts:82–85`; `src/config.ts:106–107`; `deploy/compose.yaml:38–40`.

Every subprocess receives `process.env`. Variables intended only for the panel therefore enter Compose interpolation too. For example, the supplied deployment sets `PORT=5081`, which can override a stack's own `.env` value when its Compose file uses `${PORT}`. Panel credentials and unrelated process secrets are also available to interpolation if referenced by a Compose file. Inherited Docker/Compose control variables are not constrained to the documented local context.

Reproduction: with a synthetic `CP_AUDIT_VALUE=audit-process-override` in the process, a different value in the fixture's `.env`, and `name: ${CP_AUDIT_VALUE}`, the actual local Compose CLI resolved the name to `audit-process-override`. Only `compose version` and `compose ... config --format json` were used; no daemon mutation was performed. [Docker documents that shell values take precedence](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#ways-to-set-variables-with-interpolation).

Existing tests and deployment documentation intentionally accept process `COMPOSE_PROJECT_NAME` precedence. This is therefore a boundary-hardening issue requiring an explicit policy decision, not grounds for silently removing all process overrides. Document the decision in an ADR before changing that contract. Separate panel-only secrets/settings from an explicit Compose environment and preserve required executable, registry and local-daemon settings deliberately. No disclosure of a real credential or operation against a remote daemon was tested.

## Controls that held during review

- Sensitive routes require an in-memory authenticated session; mutation handlers enforce per-session CSRF and Origin/Referer checks.
- Random session/token generation, HttpOnly and SameSite cookies, configurable Secure cookies, restrictive HTML CSP and no-store responses are present.
- Compose text and diagnostic output are HTML-escaped; streamed browser text uses `textContent`.
- Commands use explicit argument arrays with a configured executable; no user-controlled shell command endpoint was found.
- Stack names are constrained; Compose discovery rejects ambiguous files and project mappings. Creation checks project-name collisions and operations reserve project names.
- Atomic replacement, content hashes, backups, per-stack locks and post-validation file checks provide useful save protections.
- Output retention, subprocess durations and SSE subscriptions are bounded. Unknown termination retains operation locks. Linux process-group escalation has dedicated tests.

## Validation and limitations

- `bun run test`: **180 passed, 14 skipped, 0 failed**, 461 assertions across 18 files, Bun 1.4.3 on Windows.
- `bun run typecheck`: **passed**, no type errors in 35 files.
- Temporary reproduction harness confirmed A1, A2, A4, H1 and the environment-precedence behavior in H2. It used only synthetic credentials and temporary files and was removed after the review.
- The actual Compose CLI was used only for daemon-independent version/config commands. Discovery in the environment/symlink fixture was stubbed. No running Docker resources were modified.
- The skipped tests include Linux filesystem/signal behavior and opt-in Docker integration. WSL distribution enumeration returned `E_ACCESSDENIED`; Linux behavior was not certified by the Windows run.
- The image was not built or scanned during this audit. No current CVE inventory, browser-level DNS-rebinding exploit, public-proxy penetration test or load/stress test was performed.
- Point-in-time filesystem checks do not constitute a transaction against privileged local writers. Trusted administrators' ability to deploy privileged containers is an accepted product property, not reported here as a vulnerability.

## Change and rollback report

- Original audit: report only. Remediation pass (A1–A3) touches `src/auth.ts`,
  `src/app.ts`, `src/status.ts`, `src/compose-provider.ts`, `src/stacks.ts`,
  `src/editor.ts`, the matching tests, and `docs/security.md`/`CHANGELOG.md`.
- Application behavior: login throttling, stream revocation and `.env`
  validation strengthened; the happy paths are unchanged.
- Failure/rollback behavior: A1–A3 are ordinary code changes; revert the
  commit and re-run both quality gates to roll back. No deployment or
  application mutation was performed during the audit.
- Dependency delta: none in the remediation pass (the earlier toolchain change
  removed `typescript`).
- Still to verify before remote exposure: A2 expiry-close under a real long
  lived stream, A3 symlinked-`.env` refusal on a Linux host, and the A4/H1/H2
  decisions. Manually verify session revocation, expected environment inputs
  and allowed Host behavior on the intended loopback/SSH deployment.
