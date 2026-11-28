# Dictate — build brief for Claude

File:line references are against `main` at `1489fcb` (2026-11-27). Re-check
them before you rely on one; the root `CLAUDE.md` rules still apply (read
`ENHANCEMENTS.md` first, tests are the fence, `guardSpend` first).

## Status (2026-11-27)
**v1 is built in the same PR as this brief (#145), founders only.** Tom's
decisions that day, which settle most of "Open questions" below:

- **Phone-first.** Liz adds taoslite.com to her home screen and uses it on her
  iPhone. One thumb: big mic, big Copy, Share where the browser has it.
- **A second mode, Decoder (paste-in)** — see its own section below.
- **No metering and nothing stored** while founders-only. No row in
  `taos_lite_translations`.
- **Gate:** founders only. Liz is in `FOUNDER_EMAILS` (`lib/release.ts`).
- **Spanish strings** follow the owner-language chrome rule and are each marked
  `// pendiente de revisión por Liz`.
- Last style, output language and mode are kept per device.
- **Ten minutes, in chunks** (Tom, 2026-11-27 08:54 MT; was two minutes). The
  screen records the way a long home turn does — `createChunkedRecorder`,
  4.5-minute chunks, hard stop at 10:00 with everything captured written up,
  home's glow from T-30 s. The rewrite runs once on the whole transcript.
- **The iOS app (`taos-dictate`) calls the same route** with a Supabase access
  token. See **API contract** below — that section is what the app is built
  against. As part of this, a request with no valid token is now **401 before
  the founders gate's 404** (it was 404 first).

Where it lives:

| piece | file |
|---|---|
| route (audio, re-style, decode) | `app/api/dictate/route.ts` |
| prompts | `lib/dictate/prompt.ts` |
| model calls + Decoder JSON parsing | `lib/dictate/restyle.ts` |
| styles, limits, per-device storage | `lib/dictate/style.ts` |
| screen | `components/DictateShell.tsx`, `app/dictate/page.tsx` |
| gate | `dictateEnabled()` / `dictateVisibleTo()` in `lib/release.ts` |
| tests | `tests/dictate-prompt.test.ts`, `tests/dictate-route.test.ts`, `tests/dictate-shell.test.ts`, `tests/dictate-bearer-auth.test.ts` |

Three things the build does differently from the text below, on purpose:

1. **Languages travel as catalog codes, not labels.** The browser sends
   `source` / `target` / `reader` / `other` as codes and the route looks the
   label up (`languageLabel`). A label typed by the caller would be text placed
   straight into the system prompt.
2. **No "re-style" button.** With a result on screen, tapping another style
   pill (or changing the output language) re-writes the same transcript.
3. **No provider `details` in an error body or a log.** A provider error can
   quote the request back, and the request is somebody's words.

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

## Decoder (paste-in) — added 2026-11-27
The second tab on `/dictate`. Use case, in Tom's words: he receives fast,
messy, unpunctuated Spanish texts from Liz and needs to understand them.

- **In:** a paste box. A **Paste** button reads the clipboard where the browser
  allows it (`navigator.clipboard.readText`); where it does not, the box still
  takes a manual paste and the screen says so.
- **Request:** JSON on the same route, no STT:
  `{ mode: "decode", raw, reader, other }`. `reader` is the phone owner's side
  of the pair (`pair[0]`), `other` is the other side. Same text cap as a
  re-style (`DICTATE_MAX_TEXT_CHARS`).
- **Out:** `{ mode: "decode", raw, cleaned, translation, notes, sourceLanguage }`.
  - `cleaned` — the message in its **original language**, with punctuation,
    capitals, accents and sentence breaks restored and texting abbreviations
    written out. The words, their order and the tone stay the writer's.
  - `translation` — faithful, into the reader's language. A message already in
    the reader's language is translated into `other` instead, so the same
    screen works on Liz's phone for Tom's English texts.
  - `notes` — short strings in the reader's language, one per place that stays
    open to more than one reading even after reading the whole message. Usually
    empty. The UI shows them in a "Not clear in the original" box.
- **Prompt:** `buildDecoderInstructions(readerLabel, otherLabel)` in
  `lib/dictate/prompt.ts`, called with `response_format: json_object`. Rules:
  preserve meaning and tone, everything comes from the message, flag the
  genuinely ambiguous briefly rather than guess, translate a question rather
  than answer it. Register is the house default, tú — these are messages
  between two people who know each other.
- **A reply missing either text is a 502**, not half an answer
  (`parseDecoded`, `lib/dictate/restyle.ts`).
- Probed live against `gpt-4.1` on 2026-11-27 before and after the notes
  wording was tightened: the first draft flagged places the rest of the message
  already settled ("llego tipo 7 o 730 … but context suggests arrival"); the
  shipped wording returned no notes for clear messages and one note each for
  "lo ve el viernes con ella" and "deje el banco aquí".

## Server
- New route `app/api/dictate/route.ts`. Don't extend `/api/translate`: it is
  816 lines of chunking, auto-detect, retry and review capture that Dictate
  wants none of. The shape to copy is `app/api/fast/listen/route.ts:88-164`.
- Two request shapes on the one route:
  - multipart with `audio` → transcribe, then restyle;
  - JSON `{ raw, style, … }` → restyle only (re-style, no STT spend). Cap
    `raw` length.
- **Order of checks** — *as built, changed 2026-11-27:* `guardSpend(req)` with
  **no** `allowAnonymous`, then `guard.response` (**401**), then the gate →
  **404** when not visible, all before the body is read. (The first build
  copied `/api/fast/listen`'s gate-then-401; the iOS app needs a bad token to
  read as 401, so Dictate differs from /fast here on purpose.)
  `tests/spend-guard.test.ts:298-362` sweeps `app/api` and fails any route that
  names a paid provider without a guard.
- Recording cap: **10 minutes, in chunks** (Tom, 2026-11-27). Every request
  stays well under Vercel's 4.5 MB body limit (32 kbps ≈ 240 KB a minute; a
  4.5-minute chunk ≈ 1.1 MB); `maxDuration` is 300. See **API contract**.
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
- **Silence can come back as words.** Live run, 2026-11-27: two seconds of
  digital silence went through the real handler and `gpt-4o-transcribe`
  returned "I need a doctor.", which was then styled and returned as a 200.
  The 422 path only fires when the transcriber returns `""`, and for silence it
  does not always. This is the shared transcriber (`lib/translate/transcribe.ts`)
  and home has the same exposure; it is not fixed here. A level check in the
  browser is the obvious guard, but an `AudioContext` on iOS can sit suspended
  without throwing, which would turn it into a false "nothing heard" on the one
  phone this screen is for. Decide with a phone in hand.
- Don't touch release flags in Production, Stripe, or Supabase schema without
  Tom. v1 as written needs no migration.

## API contract (for the iOS app `taos-dictate`)

One endpoint does everything the app's first version needs — speak, the
chunked long dictation, re-style and the Decoder:

```
POST https://taoslite.com/api/dictate
```

Pinned by `tests/dictate-bearer-auth.test.ts` and `tests/dictate-route.test.ts`.
If you change the route, change this section in the same PR.

### Auth
- Header on **every** request: `Authorization: Bearer <Supabase access token>`.
  The token is the `access_token` of a session from the **same Supabase
  project the website uses** (URL and publishable key: `lib/authServer.ts`) —
  the same users, so a founder's account works in the app with no setup.
- The server verifies it with Supabase on each request
  (`supabase.auth.getUser(token)`, `lib/authServer.ts`); nothing is trusted
  from the client and no session is kept server-side. There is **no cookie
  auth** — the web screen sends this same header (`lib/authClient.ts`).
- Access tokens are short-lived (Supabase default: one hour). Let the Supabase
  SDK refresh them; on a **401**, refresh once and retry, then sign in again.
- Order: **401** (no / bad / expired token) → **404** (valid user who is not
  let in: founders only until `NEXT_PUBLIC_ENABLE_DICTATE` is set) → the body
  is read. Both refusals cost nothing.
- **No CORS headers are sent**, on purpose. A native app does not need them;
  do not call this from a web view on another origin.
- Send a filename and content type that match the audio (`audio.m4a` /
  `audio/mp4`, `audio.webm` / `audio/webm`, also wav/mp3) — the transcriber
  goes by them.

### Languages and styles
- Languages are **catalog codes** (`lib/languages/catalog.ts`): `en`, `es`, …
  never a display name. An unknown code is a 400.
- `style`: `formal` | `professional` | `conversational` | `casual`. Anything
  else, or absent, is `professional`.
- `target`: a code, or `same` / absent / equal to `source` = no translation.

### "Our words" — optional on every request
`words`: the caller's own names and words, spelled their way (Tom: "Lu, not
Lou"). In multipart it is a **JSON string** (`["Lu","Marcela"]`); in a JSON
body, an array. It goes to the transcriber as a spelling hint and to the
writer as "spell these exactly as listed, in any language" — dictation,
re-style and the Decoder. Send it on **every** request of a long dictation
(earlier chunks are transcribed with it too). At most 50 words of 40
characters; quotes, brackets and line breaks are stripped; repeats dropped.
Anything malformed is ignored, never an error. The server stores none of it
(`lib/dictate/words.ts`, pinned by `tests/dictate-words.test.ts`).

### Dialects — optional on every request
`dialects`: one region per language, as **codes** —
`{"es":"VE","en":"US"}` (multipart: a JSON string; JSON body: an object).
The labels that reach the prompt ("Venezuelan Spanish") come from the table
in `lib/dictate/dialect.ts`; an unknown language or region is ignored, never
an error. Regions today: es VE CO MX AR CL PE CU PR DO US ES · en US GB AU CA
IE · pt BR PT · fr FR CA · de DE AT CH.
- Dictation: the speaker's words are read in the `source` dialect; the text is
  written for a reader of the `target` dialect (or the source's, untranslated).
- Decoder: both sides' dialects are named, so "arrecha" from a Venezuelan
  reads as angry.
- Idioms (always, whenever text crosses languages): a saying travels by its
  meaning — the target's own saying where one exists, otherwise plain words;
  a half-said saying counts. Pinned by `tests/dictate-dialect.test.ts`.

### 1. Speak — one recording (up to one chunk)
`multipart/form-data`:

| field | | |
|---|---|---|
| `audio` | file, required | ≤ 4,000,000 bytes |
| `source` | required | language spoken |
| `style` | optional | |
| `target` | optional | |

`200` → `{ "raw": "<transcript>", "styled": "<clean text>", "style": "formal", "lang": "en" }`
(`lang` is the language `styled` is in.)

### 2. Speak — a long dictation, in chunks (up to 10:00)
Why chunks: a request body over **4.5 MB** is refused by Vercel before the
route runs, and one function call has **300 s**. Ten minutes in one upload
fits neither. So the audio goes up in pieces, each a **complete, separately
decodable file**, and the server is **stateless between them** — the client
holds the transcripts and hands them back with the last chunk. It is the home
screen's long-turn protocol (`lib/translate/longTurn.ts`).

**a. Each earlier chunk**, as soon as it closes (keep recording meanwhile):

| field | | |
|---|---|---|
| `audio` | file, required | ≤ 4,000,000 bytes |
| `source` | required | |
| `chunk_part` | `1` | marks "not the last" |
| `chunk_index` | `0`, `1`, … | |
| `chunk_ms` | integer | this chunk's length |

`200` → `{ "chunk": { "index": 0, "text": "<transcript>", "ms": 270000 } }`
`text` may be `""` (a quiet chunk) — that is not an error. No rewrite runs.
If this request fails after a retry, do **not** abandon the dictation: record
the chunk as lost (below) and carry on.

**b. The last chunk**, when the speaker stops or the cap is reached:

| field | | |
|---|---|---|
| `audio` | file, optional | omit only if the last chunk is empty |
| `prior` | JSON string, required | the earlier chunks, in order |
| `chunk_index` | integer | = number of earlier chunks |
| `chunk_ms` | integer | this chunk's length |
| `source`, `style`, `target` | as in 1 | |

`prior` is `[{ "text": "…", "ms": 270000 }, { "lost": true, "ms": 270000 }]`
— `text` is exactly what (a) returned; `lost` is a chunk whose transcription
failed. Do not send `chunk_part` here.

`200` → `{ "raw", "styled", "style", "lang", "chunks": 3, "lost": 0 }`
The rewrite runs **once** over the whole stitched transcript. A lost chunk
appears in both texts as `[audio lost 4:30]` (`[audio perdido 4:30]` in
Spanish) where it was lost. A last chunk the server cannot transcribe is
marked lost the same way rather than failing the request.

Limits: **10:00** total — the client enforces the hard stop (stop recording at
10:00 and send what was captured; never discard). The server refuses reported
lengths (`chunk_ms` + every `prior[].ms`) over 10:30 with a 413. At most **12
chunks** including the last; each ≤ 4,000,000 bytes; earlier transcripts ≤
24,000 characters together. The web screen uses 4.5-minute chunks (three
requests for ten minutes); shorter is fine. Give the last request a client
timeout near 280 s and earlier chunks ~210 s; a long rewrite is slow.

### 3. Re-style — same words, another style or language (no audio)
`application/json`:
`{ "raw": "<the raw transcript from 1 or 2>", "style": "casual", "source": "en", "target": "same" }`
`raw` ≤ 24,000 characters. `200` → `{ "raw", "styled", "style", "lang" }`

### 4. Decoder — a pasted message, cleaned and translated
`application/json`:
`{ "mode": "decode", "raw": "<pasted text>", "reader": "en", "other": "es" }`
`reader` is the app owner's language, `other` the other side of the pair; they
must differ. `raw` ≤ 6,000 characters.
`200` → `{ "mode": "decode", "raw", "cleaned", "translation", "notes": ["…"], "sourceLanguage": "Spanish" }`
(`notes` is usually empty, at most six.)

### Errors
Every error is JSON `{ "error": "<message>" }` with `Cache-Control: no-store`.
The message is safe to show; some are bilingual ("… · …").

| status | when | client should |
|---|---|---|
| 400 | malformed body, missing `audio`/`source`, unknown language, bad `prior`/chunk fields, empty `raw` | fix the request; do not retry |
| 401 | no token, or one Supabase rejects (expired, forged) | refresh the session, retry once, else sign in |
| 404 | `{ "error": "not_found" }` — signed in, not let in | show "not available"; do not retry |
| 413 | audio > 4,000,000 bytes; text over its cap; reported length > 10:30 | chunk smaller / shorten |
| 422 | nothing was heard in the whole dictation (silence) | say so; let them try again — nothing was rewritten |
| 429 | **not sent by this route today** (nothing is metered while founders-only). Reserved for when metering lands | back off; honour `Retry-After` if present |
| 500 | server misconfiguration | report |
| 502 | the transcriber or the model failed | retry once |
| 504 | a provider timed out | retry once |

Every attempt is paid for: retry at most once, and never on 4xx.

### What the server does not do
Nothing is stored (no row, no audio, no transcript) and nothing is metered
while this is founders-only. One log line per request,
`[taos-dictate-timing]`, with codes, counts and milliseconds — never words.

## Open questions for Tom
1. ~~Metering~~ — **settled 2026-11-27: none while founders-only.** Must be
   settled again before `NEXT_PUBLIC_ENABLE_DICTATE` is set.
2. ~~Are dictations saved anywhere~~ — **settled 2026-11-27: no, not while
   founders-only.** Gone when the screen closes.
3. ~~Recording cap~~ — **settled 2026-11-27: ten minutes, chunked like home**
   (`DICTATE_MAX_RECORDING_MS`, `DICTATE_CHUNK_MS`).
4. Formal/Professional → usted when translating to Spanish (Liz).
5. Spoken language: always the owner's side of the pair, or auto-detect between
   the two? (Built as the owner's side.)
6. Decoder: when the pasted message is already in the reader's language it is
   translated into the other side of the pair. Is that what you want, or should
   it only clean it up?

## Acceptance (Tom on his iPhone, preview URL)
- Speak a rambly 20-second thought → Formal output reads like an email he'd send.
- The same recording re-styled to Casual reads like a text he'd send.
- "Tuesday, no, Wednesday" → only Wednesday survives.
- Nothing invented. Copy works. Share works.
- Decoder: paste one of Liz's real unpunctuated texts → the punctuated Spanish
  reads like what she meant, the English says the same thing in her tone, and
  a note appears only where the original really is unclear.
