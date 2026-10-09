# ADR 0006 — In-memory operations, one per stack, no replay

Status: accepted.

## Decision
- Allowed actions are a fixed allow-list: `up`, `stop`, `restart`, `down`, `pull-up` (pull then up). Arguments are built by the provider; no arbitrary command or user-supplied option ever reaches the CLI.
- `up` runs detached (`up -d`); the panel does not attach to container output. That belongs to the streaming phase.
- One modifying operation per stack, enforced by the same per-stack lock used by saves. A second request is rejected with `409` rather than queued.
- Operations live in memory, tied to the server process, not to any client. Closing the browser does not cancel an operation; the output is still consumed and retained (bounded) for the next reload.
- `SIGTERM`/`SIGINT` refuse new operations and drain running ones for a bounded window, then the process exits.
- Success is announced only after a clean exit code 0. A timeout is reported as `unknown`, never as success.
- There is no persistence, no queue and no automatic replay. After a crash the operation outcome is unknown; the UI re-reads Docker and states the uncertainty.

## Why
This matches the product non-goals: a small single-process tool, Docker as the source of truth, no durable operation store in V1. Rejecting concurrency keeps the file/lock model simple and honest. Re-reading Docker after a restart is the only truthful way to report state we did not persist.

## Consequences
- A crashed panel loses operation history and cannot prove what happened. This is stated, not hidden.
- Horizontal scaling or durable history would require a new ADR and a real store (see ADR 0002).
- Per-operation output is capped; very chatty operations are truncated with a visible flag.
