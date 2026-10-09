# ADR 0002 — No database for operations in V1

Status: provisionally accepted.

## Decision
In-memory operation manager, a single process and a single instance. An operation continues after the browser closes, but its traceability is not guaranteed in the event of a crash/restart. Reject mutations while the server is shutting down. On restart, re-read the Docker state, never replay automatically.

## Why
The scope and tooling are deliberately small; there is not yet a demonstrated need for durable history. Adding SQLite prematurely creates a second state to manage.

## When to revisit
If execution proof, logs viewable after a crash, audits or recovery become a real need. In that case, document the guarantees and add a minimal migration, not a generic queue.
