# ADR 0009 — Activity audit log and no-lockout login backoff

Status: accepted.

## Decision
- The panel writes an append-only **activity audit log** as plain NDJSON files,
  one file per period: default daily `<YYYY-MM-DD>.log` (monthly optional),
  kept under `<stacksRoot>/.compose-panel/audit/` and overridable with
  `COMPOSE_PANEL_AUDIT_DIR`. The most recent `COMPOSE_PANEL_AUDIT_RETAIN_FILES`
  (default 31) files are kept; older ones are pruned on rollover.
- Recorded events are **auth and actions only**: login success/failure/refusal,
  logout, file-save outcomes, and operation start/refusal/final outcome. Lines
  never contain passwords, password hashes, `.env` values or Compose output.
  The typed username is never written either (people type their password
  there by mistake): only whether it matched the admin account. Fields are
  single-line and length-capped.
- Growth is bounded: each period file has a size cap
  (`COMPOSE_PANEL_AUDIT_MAX_FILE_BYTES`, default 10 MiB) after which one
  `suspended` marker closes the period, and sign-in refusals/failures, which
  any client can trigger, are capped per minute and summarized in one
  `suppressed` line.
- Behind a trusted proxy the actor is the **last** `X-Forwarded-For` entry,
  the one our proxy appended; earlier entries are client-controlled and would
  let an attacker write someone else's address into the log (and get it
  banned by a host-level watcher).
- The log is consulted through an authenticated, read-only `/audit` page
  (parsed table, period selector, manual refresh). Reads are bounded to the tail
  of one period file; filenames are derived from a validated period, never from
  user input.
- Login throttling no longer hard-blocks a client on failed attempts. A key over
  its limit is served with a bounded, exponentially growing **delay** (from
  250 ms up to `COMPOSE_PANEL_LOGIN_BACKOFF_MAX_MS`, default 2 s). A key may
  have only one attempt in progress: a parallel attempt from the same key is
  refused, so a source cannot bypass its own delay. The global in-flight
  verification cap is taken only after the delay, so delayed attempts never
  hold one of its slots; it remains a transient refusal under load.

## Why
The product is a single-admin, loopback-first tool. A hard per-client lockout
keyed by source means anyone who can send failed logins can deny the real
administrator access — a self-inflicted denial of service. Because the panel
cannot tell the admin from an attacker before verifying the password, the honest
control is to keep the admin able to authenticate while collapsing an attacker's
throughput: Argon2id plus a bounded concurrency cap plus a per-key delay. A real
source-IP ban belongs at the host layer (fail2ban/CrowdSec), which the audit log
now makes possible to filter on.

Audit files, not a database, follow ADR 0002 (no operation store in V1): plain
files on the host are inspectable, greppable and directly consumable by a
host-level log watcher, and removing the panel leaves them intact.

## Consequences
- A writable directory is added under the panel's own metadata area
  (`<stacksRoot>/.compose-panel/`); writes are best-effort and never fail the
  request that produced them. A write failure is reported to the server log.
- There is no in-memory history and no database: the files are the whole record.
  Retention bounds growth; reads are bounded.
- Brute-force resistance comes from Argon2id cost, the per-key delay and the
  one-attempt-per-key rule rather than from a failure counter. A single source
  cannot lock the admin out: it can only slow down attempts that share its key
  (the same address). Many distinct sources can still saturate the global
  verification cap and cause transient refusals; that is a distributed attack,
  handled at the host layer. This is accepted and stated in `docs/security.md`.
- Audit files are sensitive (activity, source keys): they are served only behind
  auth, `no-store`, HTML-escaped, and never published.
- `COMPOSE_PANEL_LOGIN_BLOCK_MS` is replaced by
  `COMPOSE_PANEL_LOGIN_BACKOFF_MAX_MS`; the old hard-lockout semantics are gone.
