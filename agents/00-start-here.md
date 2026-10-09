# Agent instructions

Language: all code, comments, identifiers, tests, UI strings and documentation delivered by agents (including `docs/`, ADRs and this folder) must be written in **English**. The mission briefs below may remain in French, but the deliverables are in English.

Read `AGENTS.md` and the referenced documents before coding. Agents work **sequentially** on PRs P1→P6, except documentation tasks with no shared file. Do not code features that were not requested.

Each agent must: (1) audit the existing code, (2) explain the chosen contract and its limits, (3) implement minimally, (4) add tests, (5) run the quality gates, (6) deliver a diff and a note of the verified scenarios. If no disposable Linux daemon is available, leave the integration test explicitly unvalidated — do not invent a success.

The UI and services must never depend on the browser to finish an already-accepted Compose action. No implicit replay after restart.
