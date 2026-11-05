# Merge authority — what an agent may land on `main` without asking

Every merge to `main` is a production release (Vercel auto-deploys `main` to
taoslite.com). These are the rules Tom set for agents that merge on his go.
They are restated here so a future session finds them without a transcript.

## 1. Conflicts are not an escalation. Deletions are.

A rebase conflict is ordinary work: resolve it and keep going. A **deletion**
is the line to stop at: if a resolution removes a line that existed on either
side of the conflict, stop and report. Do not guess which side was right.

## 2. Resolve without asking

- Both sides appended to the same docs, tests, imports, or constants — keep
  both, in a sensible order.
- Lockfiles — regenerate from the merged `package.json`; do not hand-merge.
- Whitespace and formatting differences.

## 3. Stop and report

- Any deletion (see 1).
- Two bodies of the same function.
- A semantic conflict in the live-call path: `components/CallShell.tsx`,
  `lib/call/session.ts`, `lib/call/interpreter.ts`.
- Two migrations touching one column.
- User-visible copy changes.
- Anything that makes something public (a route, a page, a bucket, a flag
  default).

## 4. Never delegated

- Never close #31 or #16.
- Never close a PR whose content is not verified on `main`.
- Rebase onto the latest `origin/main` before every merge.
- Suite green (typecheck, lint, test, build) or stop.
- Sibling worktrees only; never work in the main checkout.
- Never delete branches.
- Every merge is a release: verify each one on production before the next.

## 5. Report format

1. **What shipped** — merge shas, test counts, production sha and state,
   smoke results.
2. **Calls I made you can reverse.**
3. **Decisions only Tom can make** — env var names if any. "Nothing needs
   you" is a valid answer.
