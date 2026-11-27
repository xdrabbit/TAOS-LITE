# Dictate — build brief for Claude

File:line references are against `main` at `1489fcb` (2026-11-27). Re-check
them before you rely on one; the root `CLAUDE.md` rules still apply (read
`ENHANCEMENTS.md` first, tests are the fence, `guardSpend` first).

## What we're building
Dictate mode for TAOS-LITE. You tap the mic, talk, tap again, and TAOS returns
**clean, styled text in the same language** (or optionally in a target
language), ready to copy or share. This is the Wispr Flow experience built into
TAOS. It isn't verbatim: filler goes, grammar gets fixed, the meaning stays, and
nothing gets invented.

Why it's cheap for us: the two expensive halves already exist as libraries —
the transcriber and the chat client. What does **not** exist is a same-language
path: `/api/translate` refuses `source === target`
(`app/api/translate/route.ts:592-598`) and its prompt is an interpreter's
(`lib/translate/prompts.ts:144-205`). Dictate is a new route and a new prompt on
top of the shared transcriber.

## Styles (v1)
| id | label (EN / ES) | intent |
|---|---|---|
| formal | Formal / Formal | business letter or legal tone, no contractions |
| professional | Professional / Profesional | a clean work email or Slack message |
| conversational | Conversational / Conversacional | friendly and polished |
| casual | Casual / Informal | texting a friend, contractions OK, light emoji only if the speaker used that vibe |

Do not reuse the existing `Tone` type (`"casual" | "detailed"`,
`lib/translate/prompts.ts:8`) — it means something else and `/api/translate`
parses it. Give Dictate its own `DictateStyle` type.

Persist the last-used style **per device** in `localStorage`. That is how every
other screen choice is kept — there is no per-user UI-prefs table. Copy the
shape of `lib/live/style.ts:24-54` (key `taos.live.style`, a `resolve…` parser,
guarded read/write); use key `taos.dictate.style`.

## Pipeline (reuse, don't fork)
1. **Capture.** There is no shared mic component. Each shell wires
   `MediaRecorder` itself from the helpers in `lib/translate/recorder.ts`
   (`MIN_TURN_DURATION_MS` :19, `AUDIO_BITS_PER_SECOND` :24, `pickMimeType` :26,
   `fileNameFor` :39). The reference wiring is home's `startRecording` /
   `stopRecording` (`components/TranslatorShell.tsx:939-1045`), including the
   two iOS interruption handlers (`onError`, `track.onended`, :992-1002) — keep
   both. Home is **tap-to-toggle** (`toggleRecord`, :1347), not hold-to-talk.
   - Do **not** take home's chunked recorder (`lib/translate/chunkedRecorder.ts`,
     `lib/translate/longTurn.ts`). v1 is one recording per dictation.
   - `lib/fast/useDictation.ts:112` is a finished hold-or-tap hook that hands
     back a blob, but it is hard-wired to /fast's 30 s cap
     (`lib/fast/dictation.ts:24`) and belongs to a parked feature. Read it for
     the pattern; don't import it.
2. **Speech-to-text.** `transcribeAudio(apiKey, file, { sourceLabel })` in
   `lib/translate/transcribe.ts:116`. Model is `defaultTranscribeModel()`
   (:80, `OPENAI_TRANSCRIBE_MODEL`, else `gpt-4o-transcribe`). It already asks
   for a verbatim transcript and applies `STT_NO_GUESS_RULE` and the Cantonese
   hint. It returns `""` for unusable audio instead of throwing (:150-159).
   Pass a `timeoutMs` sized to the recording cap, as
   `app/api/fast/listen/route.ts:28,134-137` does.
3. **Restyle.** A new pure builder
   `buildDictateInstructions(style, sourceLabel, targetLabel?)` in a new file
   `lib/dictate/prompt.ts` (unit-testable, same idea as
   `lib/translate/prompts.ts`). Call the model with a direct fetch modelled on
   `paraphrase()` (`lib/translate/paraphrase.ts:24-82`): `getTranslateModel()`
   (:20, `gpt-4.1`), temperature 0.2, `AbortSignal.timeout`. Do not use
   `chatCompletion` (`lib/translateProvider.ts:69`) as is: it has no timeout and
   defaults to the mini model.
4. **Return** `{ raw, styled, style, lang }`. The UI shows the styled text and
   keeps the raw transcript behind a "show original" toggle.

### Prompt rules (non-negotiable)
- Keep every fact, name, number, date and request. Never add content, greetings
  or sign-offs unless they were spoken.
- Remove fillers (um, uh, like, you know), false starts and self-corrections.
  When the speaker corrects themselves ("Tuesday — no, Wednesday"), keep only
  the final version.
- Turn spoken punctuation and lists into real formatting ("new paragraph",
  "bullet").
- **Rewrite only.** If the dictated text is a question or an instruction, it is
  restyled, never answered or acted on. Reuse the wording of the translate-only
  fence at `lib/translate/prompts.ts:161-162`.
- Output only the text, with no preamble.
- State the behaviour you want, not the failure to avoid — naming a failure
  primes it (`lib/translate/prompts.ts:163-172`). Probe the prompt before and
  after any fence you add.
- **Do not append `MEANING_FIRST_RULE`** (`lib/translate/prompts.ts:79`) to the
  same-language prompt. It says "formal stays formal, casual stays casual",
  which is the opposite of a style knob.
- **Empty or noise never reaches the model.** `transcribeAudio` returns `""`;
  answer 422 with the bilingual `NOTHING_HEARD` line
  (`app/api/translate/route.ts:427,688-691`) and make no chat call. `paraphrase`
  throws on an empty completion (`lib/translate/paraphrase.ts:78-80`), so
  "return an empty string" is not something the model step can express.

### Register when "Translate to…" is set
The house default is tú (`DEFAULT_REGISTER`, `lib/translate/prompts.ts:52`,
from #65, Liz's 9/11 report). `registerLineFor("usted")` exists (:59-65). A
Formal letter addressed in tú reads wrong, so: Formal and Professional pass
`"usted"`, Conversational and Casual pass `"tu"`. This is new behaviour, not a
change to the pinned default (`tests/meaning-first-rule.test.ts:67-82`).
**Liz confirms before it ships.**

## Server
- New route `app/api/dictate/route.ts`. Don't extend `/api/translate`: it is
  816 lines of chunking, auto-detect, retry and review capture that Dictate
  wants none of. The shape to copy is `app/api/fast/listen/route.ts:88-164`.
- Two request shapes on the one route:
  - multipart with `audio` → transcribe, then restyle;
  - JSON `{ raw, style, … }` → restyle only (re-style, no STT spend). Cap
    `raw` length.
- **Order of checks**, exactly as `/api/fast/listen` (:94-97): `guardSpend(req)`
  with **no** `allowAnonymous`, then the gate → 404 when not visible, then
  `guard.response` (401), all before the body is read.
  `tests/spend-guard.test.ts:298-362` sweeps `app/api` and fails any route that
  names a paid provider without a guard.
- Recording cap: one request, so stay well under Vercel's 4.5 MB body limit
  (32 kbps ≈ 240 KB a minute) and set `maxDuration` and the upstream timeouts
  to match. **Default cap: 2 minutes. Tom decides.**
- One log line per request, `[taos-dictate-timing]`, in the style of
  `[taos-translate-timing]` (`app/api/translate/route.ts:66-71,360-373`): codes,
  counts and milliseconds only.
- **Metering — Tom decides.** What "counts against the free tier" means today:
  the monthly figure is a count of rows in `taos_lite_translations`
  (`getMonthlyUsage`, `lib/supabase.ts:264-273`; cap 25, `QUOTAS` :201). On home
  the **browser** inserts the row (`components/TranslatorShell.tsx:1272-1276`)
  and the browser enforces the cap (:306-307, :941). Only /fast enforces it on
  the server (`lib/fast/meter.ts:182`, `fast_begin` in
  `supabase/migrations/20260831_fast_history_guard.sql`), and that SQL stamps
  `tone='literal'`, `engine='fast'`, so it is not reusable as is.
  So "counts as one" means writing a row, and a row in that table also shows up
  in History, feeds /study lessons (`lib/study/lessonStore.ts:104`) and the
  daily email (`lib/email/store.ts:20`). **Recommendation: v1 is founders-only,
  so write no row and meter nothing; settle metering (and whether dictations
  are saved at all) before the public flag is turned on.**
- Release gate, in `lib/release.ts`, on the two-function shape `/call` and
  `/fast` use (:136-162, :189-203): `dictateEnabled()` reading the literal
  `process.env.NEXT_PUBLIC_ENABLE_DICTATE`, and
  `dictateVisibleTo(email) = dictateEnabled() || isFounder(email)`. The nav
  tile, the page and the route all ask `dictateVisibleTo`. Default:
  **founders only**. Do not set the flag in Production from an agent session
  (Tom's ceremony).
- `HELD_BACK_V1` (`lib/release.ts:41`) is pinned to exactly
  `["call","fast","video"]` by `tests/release.test.ts:78`. Founder screens added
  since (/taokie, /review, /demo) are not in it. Follow them: leave the list
  alone, wrap the page in `FounderGate`.

## UI
- New screen `app/dictate/page.tsx` + `components/DictateShell.tsx`. Page gate
  as `app/fast/page.tsx:42-46`:
  `<FounderGate publicRelease={dictateEnabled()} deny="home">`.
- Nav: the launcher grid lives inside `components/TranslatorShell.tsx`
  (:1554-1830). Add one tile inside a `{dictateVisible ? ( … ) : null}` block,
  as /fast does at :1666. Do not add it to the pill row
  (`tests/nav-pill-row-fits.test.ts`). Labels come from `lib/chrome/copy.ts`
  (`navFast` EN :126, ES :660) — add `navDictate` to both.
- Three fences fail on the day the screen lands unless you add a row:
  - `tests/nav-completeness.test.ts:53` — add `dictate: "dictateVisible"` to
    `GATED`;
  - `tests/exit-home-everywhere.test.ts:93` — add the shell to `ROUTES`, and
    render exactly one `<ExitHome/>` (`components/ExitHome.tsx:20`) first in the
    header row;
  - the same file (:204) fails any shell whose source contains the literal
    "← Home", comments included — use the component.
- Language: read `useLanguagePair()` (`lib/translate/useLanguagePair.ts:118`).
  `pair[0]` is the phone owner's side and is the default spoken language; send
  its label as `sourceLabel`. Chrome strings follow the owner via
  `copyFor(mine)`.
- Big mic, four style pills, result card with **Copy** and **Share**, "show
  original" toggle, and "re-style" (the JSON request above).
  Copy and share text the way `components/VisionShell.tsx:178-196` does
  (`navigator.clipboard.writeText`, `navigator.share({ text })`, hide Share when
  `navigator.share` is missing). `lib/tts/shareAudio.ts` is for audio files,
  not this.
- Optional "Translate to…" pill: when set, the styled output comes out in the
  target language. That's our edge over Wispr. Text-only (tier 2) languages are
  fine here — nothing is spoken.
- Every Spanish string is an agent's until Liz reads it: mark each
  `// pendiente de revisión por Liz`, as `lib/chrome/copy.ts:672-698` does.
- Auth header on every request: `authHeaders()` (`lib/authClient.ts:23`).

## Tests
- Prompt builder per style and language, including the register split and that
  `MEANING_FIRST_RULE` is absent from the same-language prompt.
- Route: 401 signed out, 404 for a non-founder with the flag off, 422 on an
  empty transcript **with no chat call made**, restyle request makes **no STT
  call**. Run the real handler with only auth and `fetch` mocked; assert on what
  was sent, not that something was called.
- `tests/release.test.ts`: the new flag defaults off and founders pass.
- The three screen fences above.
- Change tests in the same PR as the behaviour (repo rule). CI is Node 22.
- Never run prettier in this repo.

## Phases
1. **v1 (this brief):** `/dictate` screen + route + 4 styles + copy/share + flag.
2. **v1.1:** iOS Shortcut / Action Button entry. An authenticated POST of audio
   to `/api/dictate` returns styled text, and the Shortcut copies it to the
   clipboard. `guardSpend` only accepts a Supabase access token
   (`lib/authServer.ts:10`), which is short-lived, so this needs a per-user
   long-lived token story. Design it before building.
3. **Later (only if Tom wants it):** a native wrapper (Capacitor) plus a
   keyboard extension. iOS keyboard extensions can't use the mic, so it needs
   the bounce-to-the-main-app trick Wispr uses. Android IME can use the mic
   directly. Out of scope until v1 has been used daily for a week.

## Hazards
- Never put transcript or styled text in a log (privacy). Lengths, codes and
  timings only.
- Mic needs HTTPS (iPhone Safari). Test on a preview URL, not LAN HTTP. Preview
  sign-in bounces to production until the Supabase redirect list has the
  preview host.
- Copy must happen inside a tap. An automatic copy after the fetch returns is
  likely to be refused on iOS Safari; verify on the phone before promising it.
- The mic is the one place desktop engines do not reproduce iOS. Only Tom's
  phone confirms it.
- Don't touch release flags in Production, Stripe, or Supabase schema without
  Tom. v1 as written needs no migration.

## Open questions for Tom
1. Metering: unmetered while founders-only (recommended), or a row per
   dictation now?
2. Are dictations saved anywhere (History, /study), or gone when the screen
   closes?
3. Recording cap: 2 minutes?
4. Formal/Professional → usted when translating to Spanish (Liz).
5. Spoken language: always the owner's side of the pair, or auto-detect between
   the two?

## Acceptance (Tom on his iPhone, preview URL)
- Speak a rambly 20-second thought → Formal output reads like an email he'd send.
- The same recording re-styled to Casual reads like a text he'd send.
- "Tuesday, no, Wednesday" → only Wednesday survives.
- Nothing invented. Copy works. Share works.
