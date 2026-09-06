# PR Challenger

A read-only reviewer agent (`.claude/agents/pr-challenger.md`) that walks every
open PR and every unmerged remote branch and forces one verdict per PR —
**MERGE / REBASE / HOLD / CLOSE** — with the command and output behind each
claim. Its one rule is *show, don't assert*: a check it could not run is marked
`UNVERIFIED` rather than guessed.

It never merges, closes, comments, labels, rebases, pushes, or edits. The report
is a proposal; acting on it is the Driver's job.

## Run it by hand

```
cd /home/tom/blackbird_dev/TAOS-LITE
claude
> use the pr-challenger agent
```

## Run on a schedule

Mission Control runs it Saturday night. The verdict table lands in Notion
(Tablero TAOS) and one event per run is appended to
`memory/projects/TAOS-LITE/events.ndjson`.

## Why it exists

The 2026-09-03 PR review got 3 of 5 calls wrong — it asserted that PRs were
superseded or stale without checking whether their content was actually on
`main`, and without checking whether a branch was behind `main`. The two checks
that failure produced are now mandatory steps in the agent's procedure:
content-on-main before ever suggesting CLOSE, and behind-main before ever
suggesting MERGE.
