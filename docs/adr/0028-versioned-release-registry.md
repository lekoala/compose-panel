# ADR 0028 — Versioned release registry

Status: accepted

## Context

A failed publication must be retryable, including a corrected image under the
same version. ADR 0018 counts 72 hours from the GitHub release publication,
which does not date a replacement digest. Release notes alone are mutable and
do not make an earlier digest easy to review.

## Decision

Keep `releases.json` on the repository's `master` branch, with an append-only
list of version, index digest, source revision and registration time. The
publication job records the pushed digest through the GitHub Contents API
before creating or editing the release. Concurrent writes use the file SHA and
publication runs are serialized. A retry with the same latest version/digest
does not add a record or restart the waiting period. A changed digest appends a
record, preserving the previous value in the file and Git history.

The panel reads the fixed registry URL on Check and Install, with the same
bounded, redirect-refusing HTTP contract as the release. The latest record for
the image version must match its release digest. Installation waits 72 hours
from the later of the release publication and that record's registration.
Missing, malformed or mismatching registry data refuses installation. Rendering
still uses the in-memory answer and makes no network request. No local store,
database, background synchronization or operation recovery is added.

The build job has read-only contents permission; only the publication job can
write the registry and release. Publication depends on CI for the tagged commit.

## Consequences

A release-note-only edit does not restart the delay. Digest replacements are
visible in a reviewable repository file and wait again even on a new panel.
The registry is not an independent cryptographic authority: a compromised
repository writer can change both sources or rewrite history. Protect the
default branch and review the registry changes. A registry write refused by
branch protection fails publication safely; retry after resolving it. Old
versions without a registry record are unavailable to the new self-updater;
they remain installable with the host CLI. Do not backdate new records.
