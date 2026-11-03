# ADR 0034 — Compact Compose pull progress

Status: accepted

## Context

Pull and Up run Docker Compose without a TTY, so Compose uses its plain
progress output: every update of every layer is a new line
(`7801f5cb2c57 Downloading 63.96MB`). A pull of a few large images prints
thousands of nearly identical lines. The live operation view becomes hard to
follow, and the retained operation output is capped in bytes, so this noise can
push the end of the operation — the Up result or an error — past the cap.

`pull --quiet` and `up --quiet-pull` remove the noise but also every sign of
life during a long download, which leaves the administrator watching a
"Running" badge with no way to tell a slow pull from a stuck one.

## Decision

The Docker `ComposeProvider` compacts the live output of `pull` and `up`
before it reaches the operation:

- A line `<12 hex layer id> Downloading …` or `<layer> Extracting …` is kept
  when it is the first one of that status for that layer, then at most once
  every 5 seconds per layer.
- Every other line passes unchanged and in order: layer state changes
  (`Pulling fs layer`, `Download complete`, `Pull complete`), service lines,
  warnings and errors.
- Lines are classified whole: a partial line is buffered until its newline or
  the end of the command. A partial line over 64 KiB is passed through as is.

The filter lives behind the provider because the format belongs to Docker
Compose. Buffered providers and other commands are unchanged. The command's
own capture (`CommandResult`) is not filtered.

## Consequences and limits

- The live view and retained output show a progress sample per layer instead
  of every update; the final per-layer state is always shown.
- stdout and stderr share one live stream, as before: a write on one stream in
  the middle of a partial line on the other can still interleave.
- A future Compose plain format that no longer matches the pattern is shown
  unfiltered, never hidden.
