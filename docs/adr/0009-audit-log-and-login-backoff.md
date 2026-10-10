# ADR 0009 — Activity audit log and no-lockout login backoff

Status: accepted.

## Decision
- The panel writes an append-only **activity audit log** as plain NDJSON files,
  one file per period: default daily `<YYYY-MM-DD>.log` (monthly optional),
  kept under `<stacksRoot>/.compose-panel/audit/` and overridable with
  `COMPOSE_PANEL_AUDIT_DIR`. The most recent `COMPOSE_PANEL_AUDIT_RETAIN_FILES`
  (default 31) files are kept; older ones are pruned on rollover.
- Recorded events are **auth and actions only**: login success/failure/refusal,
  logout, file-save outcomes, and operation start/refusal. Lines never contain
  passwords, password hashes, `.env` values or Compose output. Fields are
  single-line and length-capped.
- The log is consulted through an authenticated, read-only `/audit` page
  (parsed table, period selector, manual refresh). Reads are bounded to the tail
  of one period file; filenames are derived from a validated period, never from
  user input.
- Login throttling no longer hard-blocks a client on failed attempts. A key over
  its limit is served with a bounded, exponentially growing **delay** (from
  250 ms up to `COMPOSE_PANEL_LOGIN_BACKOFF_MAX_MS`, default 2 s). A correct
  password is therefore never refused. The only hard refusal is the global
  in-flight verification cap, which is transient and protects CPU/memory.

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
- Brute-force resistance is bounded by Argon2id cost and the concurrency cap
  rather than by a failure counter. An attacker can still make the admin's login
  wait a few seconds under load, but can never lock them out. This is accepted
  and stated in `docs/security.md`.
- Audit files are sensitive (activity, source keys): they are served only behind
  auth, `no-store`, HTML-escaped, and never published.
- `COMPOSE_PANEL_LOGIN_BLOCK_MS` is replaced by
  `COMPOSE_PANEL_LOGIN_BACKOFF_MAX_MS`; the old hard-lockout semantics are gone.
