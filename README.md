# TAOS-LITE

A fast, dead-simple **push-to-talk translator** for two people sharing one iPhone.
Built for English ↔ Spanish, concept-level (not word-for-word) translation, with
optional spoken playback.

Production: `https://taoslite.com` (Vercel project `taos-lite`, auto-deploys
`main`). Version **1.0.0** (`lib/version.ts`); the catalog is ~100 languages
(`lib/languages/catalog.ts`). Local: `http://localhost:3017`.

Living backlog: [`ENHANCEMENTS.md`](ENHANCEMENTS.md). Agent rules: [`CLAUDE.md`](CLAUDE.md).
Architecture: [`TAOS-LITE-arch.md`](TAOS-LITE-arch.md). Docs index: [`docs/README.md`](docs/README.md).

## How it works

1. **Speak** — tap the mic, say a full thought (a sentence or a 10-minute story), tap again.
2. **Translate** — audio is transcribed (OpenAI `gpt-4o-transcribe`) and rewritten as a
   natural, **first-person, concept-level paraphrase** in the other language (no robotic
   "he is saying…" narration).
3. **Read / hear it** — the translation appears in large text and reads aloud
   (ElevenLabs or OpenAI voice), automatically or on tap.

### Modes

- **Detailed, always** — the home screen and `/try` run one tone: every fact, name, number,
  condition, and the feeling behind it, said the way a fluent native speaker would say it.
- **The exceptions** — `/fast` is the one literal surface (word-level, for a sign or an address);
  `/live` is the one that summarizes (rolling gist of a room).
- **Swap** — flip the direction (Liz · Español ↔ Tom · English) with one tap.
- **Auto-play voice** — speak the translation automatically after each turn (Use Case 2),
  or turn it off and tap the speaker icon (Use Case 1).

The whole app is one screen: who's speaking, the translation, and a big mic button.

## Screens

Home (`/`) is the push-to-talk screen above. The others share the same saved
language pair (`lib/translate/useLanguagePair.ts`). Gates live in
`lib/release.ts`, pinned by `tests/release.test.ts` and
`tests/nav-completeness.test.ts`.

| Route | What |
| --- | --- |
| `/` | Spoken turns (`TranslatorShell`). This is home. |
| `/live` | Ambient follow-along over OpenAI Realtime / WebRTC. |
| `/chat` | Two-person text + voice notes, each translated for the reader. |
| `/tabletop` | Phone-flat, push-to-talk mode for two people at a table. |
| `/translate` | Typed translation with predictive autocomplete. |
| `/vision` | Photo translator. |
| `/tutor` | Crawl / walk / run tutor (`NEXT_PUBLIC_ENABLE_TUTOR` — on in Production). |
| `/study` | Lessons from your own conversations (`NEXT_PUBLIC_ENABLE_STUDY` — on in Production). |
| `/about`, `/guide` | Product page + how-to. |
| `/try` | Anonymous, no-sign-up translator (rate-limited). |

Held back (the code stays in the repo):

- `/call` — 1:1 interpreted calls. Founders and the server-only
  `CALL_ALLOWLIST_EMAILS` test pairs, unless `NEXT_PUBLIC_ENABLE_CALL=1`.
- `/fast` — the literal quick-translate box. Founders only unless
  `NEXT_PUBLIC_ENABLE_FAST=1`. Its own mic is parked for everyone
  (`NEXT_PUBLIC_ENABLE_FAST_MIC`).
- `/video` — captioned video. Founders only.
- `/live`'s on-device speech engine — off unless `NEXT_PUBLIC_ENABLE_ONDEVICE_STT=1`.

## Pipeline

```
mic → MediaRecorder → POST /api/translate (transcribe → paraphrase) → text
                                                        ↓ (auto or on tap)
                                            POST /api/tts → spoken audio
```

All API keys stay **server-side** in Vercel env vars. The phone never sees a key.

Money-spending routes call `guardSpend` (`lib/spendGuard.ts`) **first**, before
any provider is called (a few signed-in-only routes check the session directly
instead; see `TAOS-LITE-arch.md`). A signed-in session is the normal path. `/try` is the anonymous exception:
origin-checked, per-IP rate-limited, cheap engine only (no ElevenLabs, no
Realtime mint).

## Stack

- **App:** Next.js 14.2 (App Router), React 18, TypeScript, Tailwind
- **Auth / history / chat:** Supabase (Google sign-in)
- **Billing:** Stripe
- **Speech / translate:** OpenAI (`gpt-4o-transcribe`, `gpt-4.1` / `gpt-4.1-mini`, `gpt-realtime`)
- **TTS:** ElevenLabs (subscriber default) or OpenAI TTS
- **Tutor Crawl scoring:** Azure Speech (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`)
- **Deploy:** Vercel project `taos-lite`, auto-deploys `main`

## Layout

```
app/                  routes + API (app/api/*)
components/           screen shells (Translator, Live, Chat, Tabletop, Call, Tutor, Study, Fast, ...)
lib/                  release gates, spend guard, languages, tts, tutor, study, stripe
content/tutor-course/ course markdown (traced into the /api/tutor/lessons function)
supabase/migrations/  partial schema — many tables were applied in the SQL editor
tests/                vitest; pinned behaviors
docs/                 plans, verification notes, data map (index: docs/README.md)
tools/                local-only utilities
public/               PWA icons
```

## Environment

Copy `.env.example` to `.env.local` and fill in keys. Required: `OPENAI_API_KEY`.
For voice playback: `ELEVENLABS_API_KEY` (default engine) and/or the OpenAI key (OpenAI TTS).

`.env.local` is gitignored — never commit secrets.

`.env.example` lists every variable. Beyond the two above:

- Auth / server writes: `SUPABASE_SERVICE_ROLE_KEY` (the public Supabase URL and anon key have code defaults)
- Paywall: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and live price ids in production
- Tutor Crawl scoring: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` (`/api/tutor/assess`)
- `/call` relay: `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` (without them `/call` is STUN-only)

Release flags (`lib/release.ts`; off unless `1` / `true`): `NEXT_PUBLIC_ENABLE_TUTOR`,
`NEXT_PUBLIC_ENABLE_STUDY`, `NEXT_PUBLIC_ENABLE_CALL`, `NEXT_PUBLIC_ENABLE_FAST`,
`NEXT_PUBLIC_ENABLE_FAST_MIC`, `NEXT_PUBLIC_ENABLE_ONDEVICE_STT`, plus
`NEXT_PUBLIC_FOUNDER_EMAILS` and the server-only `CALL_ALLOWLIST_EMAILS`.
Changing any of them is a product decision; update the matching test in the
same PR.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3017`.

`npm run dev` binds port 3017. A production build runs on the same port:

```bash
npm run build
npm start
```

Mission Control target `dev` (`.mc-launch.toml`) runs the same command on the
same port; no remote tunnel is declared.

### iPhone / Safari microphone

`getUserMedia` requires a **secure context (HTTPS)**. Plain `http://` over the LAN will not
grant mic access in Safari. For real iPhone testing use the deployed HTTPS URL (Vercel), or a
local HTTPS tunnel (Tailscale Serve, ngrok, mkcert). Open in Safari and accept the mic prompt.

## Deploy (Vercel)

Push to a Git repo, import into Vercel, and add the env vars from `.env.example` in the Vercel
project settings. Vercel serves HTTPS by default, so iPhone mic + audio autoplay work out of the box.

Pushing to `main` deploys production. The auth redirect allow-list (code +
Supabase dashboard) is documented in `docs/supabase-auth-redirects.md`;
widening one list without the other is how preview sign-in silently lands on
production.

## Validation

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

Real mic + voice still require valid keys and a secure browser context.

Pre-merge, all four must pass. CI (`.github/workflows/ci.yml`) runs typecheck,
lint, and tests on PRs and pushes to `main`; markdown-only changes skip it.

## Hazards

- **Microphone:** HTTPS required on iPhone / Safari.
- **Spend fence:** `guardSpend` (`lib/spendGuard.ts`) stays the first call on
  money-spending routes. `/try` is the only anonymous path, and it is
  origin-checked plus rate-limited.
- **Realtime billing:** `/live`, `/tabletop`, `/call`, and tutor Run open
  OpenAI Realtime sessions. Silence is not billed, but every response re-reads
  the conversation, so cost grows with how long a session stays open.
  `/live` and `/tabletop` are capped (PR #42); `/call` has truncation, a
  60-minute cap, and an idle hangup (PR #39). See `docs/realtime-cost-model.md`.
- **Chat delete has no undo.** It deletes the thread for both people. Field-test
  on a throwaway thread, never the household thread.
- **Personal cloned voices** unlock with a shared code (5 taps on the title;
  `TAOS_PERSONAL_VOICE_CODE`). Never put that code in git, cards, or logs.
- **`docs/backstory.md`** is unpublished source material. Do not reword it and
  do not restore it onto `/about`.
