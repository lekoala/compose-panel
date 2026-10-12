# ADR 0024 — Controlled stack creation

Status: Accepted

## Decision

Allow the authenticated administrator to create one named directory under the
configured stacks root, containing raw `compose.yaml` and an optional raw `.env`.
This is a narrow exception to the file-generation non-goal: no templates,
catalogue, upload extraction, arbitrary path, or automatic Docker deployment.
GET/POST `/new-stack` are HTML-first; POST requires Origin, CSRF and authorization.
Drafts and errors stay authenticated, escaped and `no-store`.

Reserve the final directory with exclusive `mkdir`, mode 0700, under the shared
stack lock. Validate private temporary files in that exact directory using the
provider, explicit project-directory, Compose and interpolation files. Resolve
the effective project name without forcing the folder name; refuse unavailable
or colliding Docker discovery, and recheck it before commit. Up retains its own
ownership preflight. File creation does not reserve a Docker project for future
deployment or serialize with external CLI writers.

On Linux the new directory, Compose file and `.env` inherit the uid/gid of the
stacks root, including when the panel runs as root. Keep directory mode 0700 and
file mode 0600: `.env` stays private to that host administrator. A refused chown
fails creation and triggers cleanup rather than leaving an inaccessible
root-owned stack. The root's owner/group must identify the intended host admin;
these modes do not grant access to other users or groups. Existing files are
never chowned by creation.

Write a private `.env` before validation when supplied so relative `env_file:
.env` resolves in the same context as deployment. Otherwise explicitly use an
empty temporary interpolation file without creating a service `.env`.
Publish `compose.yaml` last with an exclusive hard link to its completed draft
(0600). This is atomic publication of the discoverable
stack, not an atomic directory rename: the reserved empty directory exists
during validation, but discovery sees no stack until Compose is published.
An existing directory, file or symlink is never replaced, even if empty.
Preserve submitted text byte-for-byte; no YAML parser or new dependency.
Hard links are required for exclusive publication. A filesystem or permission
policy that refuses them produces an explicit error and cleanup; there is no
overwrite-capable rename fallback. Docker Desktop shares and some FUSE/NFS
mounts may need a different stacks storage location.

Validation errors share the editor's diagnostic formatter: `.env` secrets are
redacted before limiting lines/characters; timed-out or truncated output is
never displayed. If cleanup also fails, the safe original application error is
kept in the partial-outcome message. Server logs carry only the stack name and
a fixed phase, never raw provider errors or diagnostics.

On Linux pin the root and new directory, anchor writes and cleanup through their
open descriptors, and recheck path identity and draft hashes after awaited
validation. Cleanup unlinks only files created by this request with matching
inode identities and removes the directory only if still owned and empty.
Never recursively delete a submitted path. A failed cleanup is reported as
incomplete, with manual inspection needed, not as a successful rollback.
These checks assume trusted privileged local writers; they do not provide a
filesystem transaction against external CLI processes.

Creation joins the save drain and blocks self-update. Authorization and shutdown
are rechecked before publishing. A crash can leave a reserved directory or
partially published pair; no restart recovery or replay is promised. Remove or
complete the files manually after inspection. Existing stacks stay untouched.

## Verification

Tests cover auth/CSRF/Origin, invalid names, bounded bodies, duplicates,
concurrency, unsafe paths, validation failures, unavailable/colliding projects,
raw text and permissions, rollback, directory substitution, revoked sessions
and shutdown. Linux tests use isolated filesystem/process fixtures; the opt-in
real Compose config test uses no daemon mutations. Manual check: create a
stack with a relative `env_file` referring to its supplied `.env`, verify raw
files and no containers, then deploy separately with Up. Try invalid Compose
and an existing name; verify the draft remains and the existing stack is intact.
When testing a root panel, give the disposable stacks root to a non-root uid/gid,
create a stack and confirm that owner can read it and run `compose config`
without sudo. Test malformed YAML with a dummy `.env` secret echoed in the
diagnostic: the syntax location stays visible and the secret is redacted.

## Limitations

Creation checks deployed Docker projects only. Two undeployed directories can
declare the same effective `name:`; their future Up still rechecks Docker project
ownership and reserves the project during the action. Creation does not inspect
every existing directory's config or reserve names for future deployment.
