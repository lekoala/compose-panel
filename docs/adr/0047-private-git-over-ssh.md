# ADR 0047 — Private Git fetch with a site deploy key

Status: Accepted (managed-site pilot)

## Context

The manual deploy in ADR 0043 can fetch a public HTTPS branch. Private Git
needs repository authentication and host verification. The same deployment
operation can serve both transports if credentials stay outside the release
and the SSH client has a fixed policy.

## Decision

- Extend the v1 manifest's existing `deploy.git.url` field to accept
  `ssh://user@host[:port]/repository/path`. An explicit account, a DNS hostname
  or IPv4 address, and simple path segments are required. HTTPS manifests keep
  their existing format. ADR 0042 and ADR 0043's HTTPS-only rules are extended
  by this ADR.
- The administrator provisions a dedicated, unencrypted deploy key with
  **read-only rights at the repository server**. The fixed files are
  `site/private/ssh/identity` and `site/private/ssh/known_hosts`. The latter
  contains the host key verified independently by the administrator. Both
  files and their directory belong to the panel UID on Linux. The panel
  refuses missing, symlinked, hard-linked, oversized or exposed credentials.
  The panel never generates, imports through the browser or copies these files
  into an attempt, release or container.
- Only the fetch subprocess gets the SSH transport and a fixed executable
  selected by `GIT_SSH`. The executable passes argument boundaries through to
  the packaged OpenSSH client. It uses the provisioned files, strict host key
  checking, public-key-only batch authentication and no inherited SSH
  configuration, agent, forwarding or persistent connections. HTTPS fetches
  and local Git commands keep their existing environment.
- SSH fetches have the existing time, transfer and output limits, under the
  same stack lock. SSH-side output is discarded from the operation view and
  audit. On refusal, the operator checks the key, access and pinned host key
  using the deployment guide. Fetch failures occur before activation and
  preserve the current release.
- The panel image adds OpenSSH client for this transport. A Linux source
  installation needs `/usr/bin/ssh`.

## Verification

Run the disposable SSH fixture with the real Git runner. Check successful
publication, a rejected client key, and an independently pinned wrong host
key. In both refusals, verify the release pointer and published releases are
unchanged and the attempt is cleaned up.
