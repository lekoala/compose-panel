# ADR 0007 — Streaming: operation observation vs log follow

Status: accepted.

## Decision
- Operation SSE (`/stacks/:name/operations/events`) is a **subscription, not an owner**: it replays the current snapshot then forwards output deltas and a terminal `done` frame. Unsubscribing or closing the browser never cancels the operation; the output keeps being consumed and retained (bounded) by the operation manager.
- Log follow (`/stacks/:name/logs/events`) is a **separate, reader-owned** `compose logs --follow` subprocess: at most one per stack, shared by all readers, killed when the last reader leaves, on explicit timeout, or on server shutdown. It never touches the per-stack modifying-operation lock (following logs is read-only).
- Both streams are authenticated SSE with heartbeat, an explicit maximum lifetime, a process-wide subscriber cap (`503` past it), and slow-reader drops instead of unbounded buffering. The retained log buffer is tail-kept and capped; ANSI escapes are stripped; the browser inserts text via `textContent` only.
- `followLogs` lives on the `ComposeProvider` boundary so engine-specific argument layout stays in one place. It takes an `AbortSignal` and forwards chunks; capping and fan-out belong to the `LogManager`.

## Why
This matches the architecture's three operation classes (short reads, long mutations, subscriptions): mutations are owned by the server process, while a follow subprocess exists solely for its readers. Killing the follow on last-reader-leave prevents orphaned `logs -f` processes; keeping operations independent of observers preserves the no-replay, crash-honest semantics of ADR 0006.

## Consequences
- After a crash, log follows are gone with the process (like operations, outcome/state re-read from Docker). No replay is attempted.
- Very chatty logs lose their head (tail-kept buffer, flagged); slow SSE readers are disconnected (client retries via EventSource).
- A second engine must implement `followLogs` (or report it unsupported loudly) without changing call sites.
