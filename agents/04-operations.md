# Agent 04 — Compose operations

**Prereq**: PR 03. **Mission**: allowed actions up, stop, restart, down, pull then up, without a shell, without injection, and without changing the project identity; a single mutation per stack. In-memory state tied to the server, not to SSE. Handle timeout, stdout+stderr logs, SIGTERM and no subscriber.

**Deliverables**: simple Operations module, HTML buttons/actions protected by session+CSRF, exact return codes, operation continues when the tab closes, subprocess tests on Linux against a disposable daemon. Do not manage a queue or add SQLite.

**Acceptance**: a second simultaneous mutation is rejected, success is announced only after exit 0, after a crash an unknown status is explained and no command is relaunched automatically.
