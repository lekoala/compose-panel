# Agent 03 — Editing and validation

**Prereq**: PR 02. **Mission**: edit the YAML and `.env` as text without a round-trip, preserve comments and permissions; validate in the effective Compose context. Use a version token (hash) to detect external changes. Account for relative paths, variables, profiles and possible multiple Compose files; on ambiguity, reject rather than guess.

**Deliverables**: safe-save workflow, backup + restore strategy explicitly documented for the Compose/.env pair, tests for conflicts, symlinks, invalid YAML, secrets. Saving protected by the same lock as Docker mutations (introduce the minimal necessary primitive).

**Acceptance**: invalid draft not published, external change not overwritten, no `.env` leakage in logs, byte-for-byte preservation of the YAML if unmodified.
