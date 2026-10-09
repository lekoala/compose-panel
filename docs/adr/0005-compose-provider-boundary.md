# ADR 0005 — Compose provider boundary (engine-neutral core)

Status: accepted.

## Decision
- All engine-specific CLI calls live behind a single `ComposeProvider` (see `src/compose-provider.ts`) exposing a few business operations: `listProjects`, `projectServices` and `validateConfig`. The rest of the application never builds `docker compose ...` argument arrays itself.
- V1 ships the Docker implementation only. `createComposeProvider` accepts `docker` and rejects any other engine with an explicit error; `podman` is reported as "not implemented yet" rather than silently behaving like Docker.
- The provider detects its capabilities at startup (`detect()`). A missing or silent provider is reported, and stack status becomes `unknown`; a command a provider does not support must fail loudly, never degrade into a silently wrong result.
- Provision for a second engine (Podman in particular) is structural only: no engine-specific branches, no `if (engine === "podman")` scattered through the code, no advertised support.

## Why
The product is centered on the Compose specification, not on the Docker brand. Keeping the CLI surface behind one boundary costs very little now and preserves the option of an engine-neutral tool. Without it, every controller would encode Docker assumptions that are expensive to unwind later.

Docker and Podman differ in important ways (Compose is a wrapper around an external provider; JSON shapes and command coverage vary; rootless changes permissions and mounts). Hiding those differences behind one interface is what makes later support realistic.

## Consequences
- Podman support is not claimed. It will require integration tests for `config`, `ps`, `pull`, `up`, `down`, project names and file mounts before any compatibility statement.
- Adding an engine means adding one provider implementation plus tests, not editing call sites.
- The abstraction stays intentionally small (three operations). New operations should be added as concrete needs appear, not speculatively.
