# Agent 02 — Docker state

**Prereq**: PR 01 delivered. **Mission**: read-only access to the real state of Compose, without assuming that folder names are project names. Bounded subprocess calls with an argument array; handle CLI errors, malformed output and the "exited(0) init + running app" case.

**Deliverables**: list, details, explicit `unknown` status when unresolved, errors without secrets, unit tests for parsing + disposable Linux Compose integration. Do not modify any Docker project during ordinary tests.

**Acceptance**: the UI status matches `docker compose ls/ps`, unknown projects are not assigned arbitrarily, no interpolated Compose data is exposed in logs.
