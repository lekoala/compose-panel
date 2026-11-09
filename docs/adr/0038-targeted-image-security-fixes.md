# ADR 0038 — Targeted image security fixes

Status: accepted.

## Context

The pinned Bun base contains apt/libapt-pkg7.0 3.0.3 and zlib1g
1:1.3.dfsg+really1.3.1-1+b1. The 2026-11-09 Trivy report flags fixable
HIGH findings: CVE-2026-109518, CVE-2026-76844 and CVE-2026-85091.
The existing build deliberately avoids blanket package upgrades.

## Decision

Allow targeted, explicitly version-pinned base-package security fixes while
retaining the pinned Bun base and Docker tooling. Install apt/libapt-pkg7.0
3.0.4 and zlib1g 1:1.3.dfsg+really1.3.1-1+deb13u1 before other package
downloads. An unavailable exact version fails the build; review and update
the pins or base digest rather than silently accepting different versions.
No distribution upgrade or runtime updater is introduced.

This amends the base-refresh-only policy in docs/ci.md. A future base refresh
should remove these pins when its packages include the fixes. CVE-2026-78661
in Compose's compiled golang.org/x/net dependency remains blocking; Debian
package updates cannot fix it and no Trivy exception is added.

## Verification and rollback

On an isolated Linux build runner, build both linux/amd64 and linux/arm64
images with a fresh build cache, inspect the three package versions with
`dpkg-query -W apt libapt-pkg7.0 zlib1g`, then run the existing socket-less
CI smoke test and Trivy scan. Verify the four Debian occurrences disappear;
the Compose finding must still fail the scan. These checks need no Docker
socket inside the image and must not mutate deployed stacks.

Local image verification remains pending: Docker daemon access is unavailable
in the Windows workspace. The existing CI image smoke and release platform
scans exercise the resulting image; no application Docker command changes.
Rollback is a revert of the targeted install and documentation; the scan
will again report the unfixed base packages. No host packages are changed.
