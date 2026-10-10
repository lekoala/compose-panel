# ADR 0011 — Pull on its own, and "Update ready" from local images

Status: accepted.

## Context
`Pull + up` downloaded images and recreated containers in one click, with no
way to see beforehand what would change. Administrators want to know which
services have a newer image, from which version to which, and where to read
about the change, before anything is recreated.

## Decision
- **`Pull` becomes an action of its own** in the fixed allow-list
  (`docker compose pull`). It downloads newer images and touches no container.
  Like the other actions it holds the stack lock, runs in the background and is
  recorded in the activity log. It is allowed on an undeployed stack (it pins
  the resolved project name like `Up`, and creates nothing).
- **"Update ready" is derived locally, without network access**, every time a
  stack page is rendered: for each service started from a tag (not pinned by
  digest), the image ID its container runs (`docker compose images`) is
  compared with the image ID the tag points to now (`docker image inspect`). A
  difference means `Up` would recreate that service with a newer image. This
  holds whether the pull came from the panel or from the CLI.
- **From → to** comes from the two images: the OCI
  `org.opencontainers.image.version` label, else the build date, else the short
  content digest.
- **The link** comes from the new image's OCI labels: a GitHub
  `org.opencontainers.image.source` becomes its releases page, another source
  or `org.opencontainers.image.url` is linked as is, and images hosted on
  Docker Hub fall back to their Hub page. Labels are untrusted: only absolute
  http(s) URLs are used, everything is HTML-escaped, and links open with
  `rel="noopener noreferrer"`.
- Both new calls are read-only, have fixed arguments and sit behind the
  `ComposeProvider` boundary. Image references reaching `image inspect` are
  validated and passed after `--`.
- Any failure means "no information", never an invented update.

## Not decided here
- Checking a registry for a newer image **without** pulling it (comparing
  digests remotely). It needs registry credentials inside the container,
  meets rate limits and has many "unknown" cases. Left in the roadmap.
- Any periodic check or notification: out of scope (no scheduler).

## Consequences
- The safe path is `Pull` → read "Update ready: 1.27.1 → 1.27.2, Release notes"
  → `Up`. `Pull + up` stays as the one-click shortcut.
- Each stack page render runs two more short read-only Docker calls for
  deployed stacks.
