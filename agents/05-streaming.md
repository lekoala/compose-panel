# Agent 05 — Logs and SSE

**Prereq**: PR 04. **Mission**: continuous consumption of the process output even without a browser. SSE is a subscription, not the owner of the command. `compose logs --follow` logs separated and stopped when no subscriber remains.

**Deliverables**: authenticated SSE, heartbeat, suitable inactivity delay, memory limits and subscriber count, strictly textual HTML output, handling of disconnects and UI reconnect. No Socket.IO and no node-pty.

**Acceptance**: closing the browser does not stop a pull, stopping the last reader stops the `logs -f` subprocess, SSE does not block the server on large volumes.
