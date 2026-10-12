# ADR 0023 — Read-only deployment metadata

Status: Accepted

## Decision

Show deployment metadata per container on the stack detail page. Use the exact
image ID reported by `compose images`, never the current local tag, to read OCI
`version`, `revision` and `source` labels and full repository digests. An image
ID is shown separately: it is not a registry manifest digest. Local builds may
have no repository digest. Replicas may run different images; do not collapse
them into one supposed stack version.

Also project an explicit allow-list of resolved service labels from `compose
config --format json`: `stack.version`, `stack.revision`, `stack.source`,
`stack.environment`, `stack.branch`, `stack.build`, `stack.build.url`, `stack.url`.
Show these separately as declared Compose metadata, never as proof of deployment:
files may have changed since the last Up. No application-specific aliases.

Config reads use the verified single-file project directory and `.env` context.
Raw interpolated config and errors never leave the provider. Values are bounded,
HTML-escaped, and links allow only HTTP(S), without credentials. The panel never
fetches declared URLs. No registry, CI API, manifest, storage or new mutation.
Missing or failed reads show unavailable information without breaking status.

## Verification

Unit fixtures cover updated tags, pinned images, replicas, missing labels,
malformed/failed reads, projection and unsafe links. The opt-in Linux Compose
config test checks actual interpolation without using a daemon. The disposable
Docker lab checks deployed image metadata. Manual verification: on an isolated
daemon deploy an OCI-labelled image, pull or retag a newer image without Up,
and confirm the deployed version stays old; edit Compose labels and confirm
only the declared section changes. Local builds show an image ID without a
fabricated repository digest. Rollback is reverting the read-only change.
