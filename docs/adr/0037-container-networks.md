# ADR 0037 — Networks in container inspection

Status: accepted.

## Context

The read-only container page (ADR 0014) shows ports and mounts but cannot
explain a container missing a network or a database DNS name. The existing
bounded `docker container inspect` response already contains that information.
Returning raw inspection data would also disclose environment secrets.

## Decision

Extend the whitelist projection with `NetworkSettings.Networks`: for each
network, retain only its name (the mapping key), `IPAddress` (IPv4), and the
string entries in `DNSNames`, falling back to `Aliases` when `DNSNames` is
absent or not an array. An explicitly empty `DNSNames` array stays empty.
Ignore malformed entries, omit empty DNS names and deduplicate names. Missing
or malformed network mappings yield an empty list; a missing IPv4 stays null.

Show a server-rendered Networks table on every container detail page, whatever
its category. Escape all values. No JavaScript or new Docker call is needed.
Do not retain network IDs, endpoint IDs, MACs, gateways or any other endpoint
field. Network membership and DNS names are observations, not a guarantee of
connectivity or DNS resolution. IPv6 and a global network view remain outside
this change; a global view needs a separate ADR.

## Verification

Unit tests cover the whitelist, DNS fallback, empty and malformed data. Route
tests cover all container categories and HTML escaping without exposing other
inspection fields. An opt-in Linux integration test uses only the guarded
disposable Docker lab, creates a network alias and checks the real detail page.

Run the isolated integration test on Windows with:

```sh
bun run test:docker-lab:wsl tests/docker-lifecycle-linux.test.ts --test-name-pattern "network membership"
```

On Linux, use `bash scripts/docker-lab/run.sh` with the same arguments.
Before release, manually open a disposable
container's page and compare its Networks table with `docker container inspect`;
check a container with no network attachment as well. Never run mutation tests
on a daemon hosting real stacks.

Verification on 2026-11-09: 875 Windows tests passed (235 skipped), typecheck
and formatting passed. The targeted Linux Docker lab test passed through WSL,
including the real server-rendered page before and after network detachment.
The manual browser check remains pending.
