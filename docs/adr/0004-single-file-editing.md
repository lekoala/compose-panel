# ADR 0004 — Single-file Compose editing with optimistic concurrency

Status: accepted.

## Decision
- A stack is editable only when its directory contains exactly one recognized Compose file and no implicit override. Multi-file Compose is rejected rather than guessed.
- `compose.yaml` and `.env` are edited as raw text. No YAML parser is involved on read or write, so comments, ordering and formatting are preserved byte-for-byte unless the user changes them.
- Concurrency uses optimistic locking: the rendered form carries a SHA-256 content hash for the Compose file and for `.env`. The save re-reads under a per-stack lock and refuses (409) if either hash no longer matches.
- Drafts are validated with `docker compose config --quiet` in the real project directory, with explicit `--project-directory` and `-f`, and the candidate `.env` passed via `--env-file`. If Docker is unavailable the save is refused: an unvalidated draft is never published.
- Before writing, the previous file is copied to `<root>/.compose-panel/backups/<stack>/`. Writes are atomic per file; if the second write fails, the first is restored from the backup. `.env` values are redacted from validation errors.

## Why
- Rejecting ambiguous multi-file stacks keeps the MVP safe and honest instead of partially editing a project we cannot reason about.
- Raw-text editing is the only way to satisfy "never round-trip YAML through a parser".
- Optimistic hashing avoids a database and fits the single-writer model, while the lock enforces invariant 7 (one modifying operation per stack).
- Requiring validation means the built-in editor cannot publish a config that `docker compose` would reject, keeping files usable by the CLI without the panel (invariant 10).

## Consequences
- A user editing files directly on disk, or a second panel, will cause a conflict rather than a silent overwrite.
- Detailed Compose error text is shown but first passed through `.env`-value redaction; this is best effort, not a proof of secret removal.
- Backups accumulate under `.compose-panel/backups` with no retention policy yet; pruning can be added later without changing the save contract.
- Multi-file/override editing needs a new ADR before it is supported.
