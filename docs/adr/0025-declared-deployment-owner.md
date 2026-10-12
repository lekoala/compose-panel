# ADR 0025 — Declared deployment owner

Status: Accepted

## Context

Some stacks are deployed by an external pipeline (a CI job, a deploy script)
while remaining ordinary Compose directories that the panel can still operate.
An action or edit made from the panel may then be overwritten by the next
pipeline deployment. The administrator should see that before acting.

## Decision

Add `stack.managed-by` to the ADR 0023 allow-list of declared service labels.
When every service that declares it agrees on one value, the stack detail page
shows a "Managed by …" badge and a warning in the Actions card. Conflicting
values show no badge; the raw values remain visible under declared metadata.

The label is informational only. It never disables, hides or confirms an
action, never changes authorization, and is not a trust signal: anyone who can
edit the Compose file can set it. No CI API, no integration-specific code or
aliases, no deployment state. Values are bounded and escaped like every other
`stack.*` label.

The badge is only on the detail page, which already reads the declared config.
The stack list and the edit page do not run `compose config`, so they do not
show it.

## Verification

Unit tests cover agreement, conflict and absence, HTML escaping, and that the
same actions remain available. Manual check in `bun run preview`: the `release`
stack shows the badge and the Actions warning; removing the label from its
Compose file removes both after a reload.
