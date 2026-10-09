# Agent 06 — Linux packaging / CI

**Prereq**: PR 05. **Mission**: reproducible build of a Linux image with Bun, Docker CLI and Compose plugin, without depending on any existing panel image. Prepare deployment with the same host/container paths, a secret stored outside the image, session data persisted if necessary and stop_grace_period.

**Deliverables**: independent multi-stage Dockerfile, deployment compose, healthcheck, backup/rollback instructions, CI steps for Linux tests (disposable daemon) + OCI build + scan, without automatically publishing images on a simple PR.

**Acceptance**: verified image, login smoke test, read/validate/save/up/down, interruption/restart, stack file persistence, panel removal without impact on Docker services. No test must touch the production Docker socket.
