# ADR 0029 — Bounded manifest transfers

Status: accepted

## Context

ADR 0026 caps the manifest read after `docker cp` writes the whole object to a
temporary directory. A replaced manifest, including a directory, can exhaust
the panel's temporary storage before that size check.

## Decision

Use `docker cp -- <id>:<path> -` to receive an uncompressed tar archive over
stdout. The existing subprocess runner gains opt-in binary capture and
termination on its byte limit. Normal operation output continues to be drained
after its retention cap. The transfer cap is the manifest cap plus 16 KiB for
headers, padding and metadata. Exceeding it terminates the read process using
the existing Linux process-group escalation and bounded reap deadline.

Parse only one regular file with the expected basename. Validate header
checksums, sizes, padding boundaries and end markers; reject extra files,
links, directories, special entries and PAX path/size/link overrides. Bounded
PAX timestamps and extended attributes are accepted without changing file
semantics. Never extract an archive or write it to disk. Malformed archives,
invalid UTF-8, failed commands or an unconfirmed exit make the action
unavailable. Unsupported tar variants are refused rather than guessed.

## Consequences

No dependency or arbitrary command is added. Manifest transfer no longer
consumes temporary disk. Docker daemon-side archive work is still subject to
Docker's own behavior; the panel bounds its client, not daemon allocations.
Unit fixtures test malformed archives and binary capture; the isolated Linux
process fixture checks termination on overflow. The opt-in disposable Docker
lab verifies real files, directories, symlinks and oversized manifests. See
the manual verification additions in `docs/deployment.md`.
