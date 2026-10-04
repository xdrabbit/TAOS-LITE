# TAOS-LITE Architecture

**Project:** TAOS-LITE
**Repo:** `/home/tom/blackbird_dev/TAOS-LITE` (GitHub `xdrabbit/TAOS-LITE`)
**Refreshed:** 2026-10-03 against `main` @ `912ce0c` (#80)
**Replaces:** the 2026-06-28 generic Next.js stub that did not describe the shipped app

## Overview

TAOS-LITE is a Next.js 14 App Router PWA: live translation for the people in
front of you. v1.0.0 (`lib/version.ts`) is the first numbered release handed to
someone who is not a founder. Production origin is `https://taoslite.com`
(Vercel project `taos-lite`, auto-deploys `main`).

Home (`/`) is push-to-talk spoken turns. The other screens share one saved
language pair (`lib/translate/useLanguagePair.ts`) and one spend / auth fence.

## Tech stack

- Next.js 14.2.33, React 18.3.1, TypeScript, Tailwind 3
- Supabase: Google sign-in, profiles, translation history, chat, Realtime
  channels (chat, `/call` signaling)
- Stripe: subscriptions + add-on packs (`app/api/stripe/*`)
- OpenAI: transcription (`gpt-4o-transcribe` / `gpt-4o-mini-transcribe`),
  paraphrase (`gpt-4.1` / `gpt-4.1-mini`), TTS fallback, Realtime sessions
  (`gpt-realtime`)
- ElevenLabs: the home screen's default voice for subscribers (free tier gets
  OpenAI voices); cloned voices behind a personal code
- Azure Speech (`AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`): tutor Crawl
  pronunciation scores (`/api/tutor/assess`), and the parked `/fast` mic
- ffmpeg-static: `/video` processing (kept external in `next.config.js`)

## Surfaces and release gates

Source of truth: `lib/release.ts`, pinned by `tests/release.test.ts` and
`tests/nav-completeness.test.ts`.

Open to every signed-in account: `/` spoken home, `/live`, `/chat`,
`/tabletop`, `/translate` (typed), `/vision` (photo). Public pages: `/about`,
`/guide`, `/try` (anonymous, no sign-up).

Flags and gates (`HELD_BACK_V1 = ["call", "fast", "video"]`):

| Screen | Gate | Production today |
| --- | --- | --- |
| `/tutor` | `tutorEnabled()` / `NEXT_PUBLIC_ENABLE_TUTOR` | **ON** — every signed-in account |
| `/study` | `studyEnabled()` / `NEXT_PUBLIC_ENABLE_STUDY` (its own flag, not tutor's) | **ON** — every signed-in account |
| `/call` | `callVisibleTo(email)` = `NEXT_PUBLIC_ENABLE_CALL` OR founder OR `CALL_ALLOWLIST_EMAILS` (server-only) | flag off; founders + test pairs |
| `/fast` | `fastVisibleTo(email)` = `NEXT_PUBLIC_ENABLE_FAST` OR founder | flag off; founders only |
| `/fast` mic | `fastMicVisibleTo()` = `NEXT_PUBLIC_ENABLE_FAST_MIC` AND `/fast` access | parked for everyone; mic routes 404 |
| `/video` | founder (`FounderGate`) | founders only |
| `/live` on-device STT | `onDeviceSttEnabled()` / `NEXT_PUBLIC_ENABLE_ONDEVICE_STT` | off; Ambient AI is the one engine |

When the tutor or study flag is off, the page redirects home and its API
routes answer 404. No tutor or study route is founder-gated; founders only
skip the meters (tutor minutes and the lesson-generation cap). See
`CLAUDE.md`, "Tutor and Study: who can reach what".

Founders are hardcoded in `lib/release.ts` plus optional
`NEXT_PUBLIC_FOUNDER_EMAILS`. Do not copy addresses into cards or logs.

### Navigation (production)

Logged-out visitors see `components/Landing.tsx`; signed-in users get
`components/TranslatorShell.tsx` (via `AppShell`). Its header has three tiers
(PR #77):

- **Pills** — the daily verbs, one touch each: Translate, Live, Table, Chat,
  and Call (only when `callVisibleTo`). No dropdown in the pill row.
- **Nine-dot launcher** — every screen as a 2-column icon grid: Speak (`/`),
  Translate, Live, Table, Chat, Call, Quick translate (`/fast`), Photo
  translator (`/vision`), Video, Tutor, Study — each behind its gate above.
- **Avatar menu** — identity only: History, How to use TAOS (`/guide`), About,
  Sign out.

Labels come from `lib/chrome/copy.ts` in the phone owner's language. Fenced by
`tests/nav-completeness.test.ts`.

## Core flows

### Spoken home (`/`)

`TranslatorShell`: MediaRecorder at a capped bitrate with a 5-minute hard stop,
to `POST /api/translate` (transcribe + concept paraphrase; tone is always
`detailed`), then optional `POST /api/tts`. Auto-detect chooses between the two
languages in the active pair only. Wake lock via `lib/wakeLock.ts`. Free tier
gets 25 translations a month (`FREE_TRANSLATIONS`, `lib/guide.ts`);
subscribers are unlimited. History in `taos_lite_translations`.

### Ambient (`/live`) and tabletop (`/tabletop`)

The server mints an ephemeral OpenAI Realtime client secret
(`app/api/live/realtime`, `app/api/tabletop/realtime`); audio goes browser to
OpenAI over WebRTC. Neither screen writes to Postgres. Context truncation caps
live in `lib/realtime/truncation.ts`, with session builders in `lib/live/` and
`lib/tabletop/`.

### Chat (`/chat`)

Two-person threads; an account can hold several (`lib/chatThreads.ts`). Invite
link (`/chat/join/[token]`), text and voice notes, each translated for the
reader. Voice audio sits in the private bucket `chat-voice`. Either member can
delete the whole thread for both (PR #37).

### Call (`/call`)

Two phones, interpreted Realtime lines, the shared language pair exchanged over
the call's signaling channel, measured per-minute spend (`lib/call/cost.ts`),
Cloudflare TURN relay (`/api/call/ice`). `POST /api/call/realtime` runs
`guardSpend`, then re-asks `callVisibleTo` before minting — the page gate is a
courtesy, not the fence.

### Tutor (`/tutor`)

Fourteen intent modules (`lib/tutor/modules.ts`), crawl / walk / run. Minute
metering is server-side (`lib/tutor/meter.ts`); progress is device-local
(`lib/tutor/progress.ts`, localStorage). Crawl scoring is Azure; the 24
languages it can score are in `lib/tutor/pronunciation.ts`.

### Study (`/study`)

Lessons from your own conversations: pick a line from your
`taos_lite_translations` history and get a breakdown (`lib/study/`), cached in
`taos_lite_study_lessons`. No pronunciation scoring in this cut. Generation is
`POST /api/study/lesson`, capped per user per month (`lib/lessonCap.ts`).

### Quick translate (`/fast`)

A typing box that translates as you type, and the one literal (word-for-word)
surface. `POST /api/fast` runs `gpt-4.1-nano` today; the Azure Translator
branch in `lib/fast/engine.ts` has no resource behind it yet
(`docs/fast-engine.md`). Metered server-side (`lib/fast/meter.ts`).

### Photo (`/vision`) and typed (`/translate`)

The photo is downscaled client-side and POSTed to `/api/vision`. Typed text goes
to `/api/text-translate`, with predictive autocomplete from your own history
(`/api/predict/*`).

## Spend and auth

`lib/spendGuard.ts` (`guardSpend`) is the fence on money routes: the refusal
happens before any provider call. Some signed-in-only routes (`/api/vision`,
`/api/chat/send`, `/api/chat/voice`, `/api/video/process`,
`/api/tutor/realtime`) check the session with `getUserFromRequest` directly
instead, still before any provider call. `/try` is the anonymous exception on
`/api/translate` and `/api/tts`: origin check plus per-IP rate limit plus the
cheap engine only (no ElevenLabs, no Realtime mint).

`PRODUCTION_ORIGIN` is `https://taoslite.com` (`lib/authRedirect.ts`). The
allow-list also covers www, the legacy `taos-lite.vercel.app` alias, Vercel
preview hosts under the team slug, and localhost. The code list and the
Supabase dashboard list must stay in lockstep
(`docs/supabase-auth-redirects.md`).

## Data

Schema audit: `docs/data-map.md` (2026-08-26, updated for PR #37 and tutor
metering). Many tables were created in the SQL editor, so
`supabase/migrations/` is not a complete schema. Only `/chat` carries messages
between two people. `/live`, `/tabletop`, `/call`, and `/vision` write nothing
to Postgres.

## Local launch

`npm run dev` binds port 3017 (`package.json`); `npm start` uses the same port
after `npm run build`. `.mc-launch.toml` declares the same command and port as
Mission Control target `dev`, local only, with no remote tunnel.

## Tests and CI

Vitest under `tests/`. CI (`.github/workflows/ci.yml`, Node 22) runs
typecheck, lint, and tests on PRs and pushes to `main`; markdown-only changes
skip it. Pre-merge locally also wants `npm run build`.
