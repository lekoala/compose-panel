# ADR 0057 - Digest-pinned transient tool images

Status: accepted (2026-11-27). Hardens the images already allowed by
[ADR 0045](0045-disposable-composer-preparation.md) and
[ADR 0049](0049-offsite-backup-and-restore.md); it adds no new image, mount or
permission.

## Context

- `restic/restic:0.18.0`, `composer:2.10.3` and `mariadb:11` were described as
  "pinned", but a tag is mutable. A registry can move it to another image
  without any panel action, no audit event and no operator review.
- These three images are not ordinary application dependencies:
  - the Restic client reads the repository password and the REST credentials;
  - the MariaDB client reads the database credential file and the dump;
  - the Composer image reads `composer.lock` and writes the release `vendor/`.
  A replaced tag would run different code with those inputs, which is a supply
  chain change, not a routine patch.
- The gateway (`nginx:1.27-alpine`) and the PHP runtime
  (`php:8.3-fpm-alpine` / `php:8.4-fpm-alpine`) are deliberately tags: they are
  the site's update channels. **Pull + up** is the documented operator action
  that refreshes them, so a moved tag is visible and intentional.
- No such update action exists for the three transient tool images. The next
  build or backup would silently use whatever the tag now points to.

## Decision

- `MANAGED_SITE_RESTIC_IMAGE`, `MANAGED_SITE_BUILD_IMAGE` and
  `MANAGED_SITE_BACKUP_DUMP_IMAGES.mariadb` are pinned as
  `name:tag@sha256:...`. The tag stays for readability; the digest is the
  identity Docker resolves.
- The digests are the multi-architecture index digests read with
  `docker buildx imagetools inspect` on 2026-11-27:
  - `restic/restic:0.18.0@sha256:4cf4a61ef9786f4de53e9de8c8f5c040f33830eb0a10bf3d614410ee2fcb6120`
  - `composer:2.10.3@sha256:2cf275428757e5435a667bfc0d038b14520ca02be2b1b70d44a05c8c19e2de48`
  - `mariadb:11@sha256:e1d5495f445654134f226f55a41ce0da227116f6f27f283101f405c794d841fc`
- Changing one of these images is a code change, reviewed with its new digest
  and shipped in a panel release. It is not an operator-side pull.
- The gateway and runtime tags are unchanged and stay on the documented
  Pull + up path. This ADR does not add an image picker or a digest field to the
  creation form.

## Consequences

- A moved tag can no longer change the code that receives the Restic password,
  the database credential or the release tree.
- A host that already has the tag but not the exact digest needs to pull the
  digest; that is one bounded `docker pull` during the first build/backup. The
  panel still does not pull tool images in advance.
- Security fixes in Restic, Composer or the MariaDB client now require a panel
  release rather than a registry-side tag move. That delay is the accepted cost
  of reviewing what reads credentials and data.
- The generated site gateway and runtime still update through Pull + up; the
  difference is documented so an operator does not expect the tool images to
  follow the same path.

## Alternatives considered

- **Keep mutable tags and document the risk.** Rejected for the three images
  that receive credentials or write the release: a registry-side change would
  bypass the release review entirely.
- **Pin every image, including nginx and PHP.** Rejected: it would remove the
  documented Pull + up update path for the public gateway and the runtime, with
  no replacement upgrade mechanism.
- **Resolve the digest at runtime.** Rejected: it needs registry access and a
  trust decision inside the panel, and the resolved digest would change between
  runs.

## Verification

- Unit tests assert that the fixed argument arrays contain the digest-pinned
  reference, and that a timed-out Restic upload is named so its cleanup can
  prove the container stopped.
- The end-to-end suites still run the same references; a lab host must pull the
  three digests once.
