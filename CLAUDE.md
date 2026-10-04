# TAOS-LITE — agent guide

Live EN⇄ES (+ZH/YUE) translation app for Tom (English) and Liz (Spanish),
deployed at taoslite.com via Vercel from `main`. Screens: /translate (spoken
turns, home page), /live (ambient), /call, /chat, /tabletop, /tutor, /study.

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

## Tutor and Study: who can reach what (as of 2026-10-04)

Both flags (`NEXT_PUBLIC_ENABLE_TUTOR`, `NEXT_PUBLIC_ENABLE_STUDY`) are ON in
Production, so `/tutor` and `/study` are live for every signed-in account.

- **No tutor or study route is founder-gated.** Founders (`isFounder()`,
  `lib/release.ts`) only skip the meters: tutor minutes (`lib/tutor/meter.ts`)
  and the lesson-generation cap below.
- **`GET /api/tutor/lessons` is public on purpose** — no sign-in. Tom's
  decision 2026-10-04: the free pair app is the funnel, revenue comes from
  businesses, and public course content is on-strategy. Do not gate it.
- **`POST /api/tutor/lesson` and `POST /api/study/lesson` are capped per user
  per UTC calendar month** (`lib/lessonCap.ts`; Tutor 30, Study 60, env
  `TAOS_TUTOR_LESSON_CAP` / `TAOS_STUDY_LESSON_CAP`). Only a real paid
  generation counts — a cache miss or Study's `force: true`; cache hits are
  free. The ledger is `public.lesson_generations`. Over the cap is a 429 with
  `code: "lesson_cap_reached"` and an `error` string both screens show.
