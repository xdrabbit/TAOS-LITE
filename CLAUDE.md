# TAOS-LITE — agent guide

Live EN⇄ES (+ZH/YUE) translation app for Tom (English) and Liz (Spanish),
deployed at taoslite.com via Vercel from `main`. Screens: /translate (spoken
turns, home page), /live (ambient), /call, /chat, /tabletop, /tutor.

## The enhancements workflow (important)

`ENHANCEMENTS.md` is the living backlog and the FIRST thing to read for any
build task:

1. Before building anything, read `ENHANCEMENTS.md` — the request may already
   be specified there, or relate to a listed item.
2. When you ship a listed item, move it to **Shipped** with date + PR number.
3. When Tom or Liz voices a future want mid-session ("someday we should…",
   "it would be nice if…"), append it to **Ideas** in the same PR or a
   follow-up commit. Never delete or reword their entries.
4. Asked "what should we do next?" — propose from **Up next**.

## Ground rules

- Tests are the fence: `tests/` pins decided behaviors (voice mapping,
  predict-model format, retry policy, prompt rules — several quote Tom
  verbatim). Never flip a pinned behavior without the user's explicit say-so
  in the current conversation, and change the test in the same PR.
- Pre-merge: `npm run typecheck && npm run lint && npm test && npm run build`
  must all pass. CI (typecheck+lint+test) also runs on every PR.
- Cloned-voice source of truth is `lib/tts/voice.ts` — IDs and the
  voice-follows-speaker rule live there; don't restate IDs elsewhere.
- Workflow: branch from latest `origin/main` (always `git fetch` first),
  PR to `main`, squash-merge after CI is green. Vercel auto-deploys `main`
  to production.
- Field reports from Tom are the primary QA signal — production issues are
  diagnosable via Vercel runtime logs (project `taos-lite`).
