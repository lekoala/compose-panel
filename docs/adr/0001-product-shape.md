# ADR 0001 — A small Compose panel instead of a fork of an existing panel

Status: accepted.

## Decision
A standalone Bun + server-rendered HTML application, one host, one trusted admin. Compose CLI drives Docker. Compose files and Docker remain the sources of truth. No coupling to another panel's protocol or database.

## Why
Reduce the operating cost and dependency footprint without losing the essential utility. `Bun.spawn` and SSE are suitable for operations and events without a SPA. No plugin or agent system in V1.

## Consequences
Features of larger panels not carried over (terminal, agents, graphical editor). Linux tests are essential. Re-evaluate only after observing real usage.
