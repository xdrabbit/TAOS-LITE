# SESSION BRIEF — /live Ambient AI mode + freshness hardening (2026-07-08)

**STATUS:** Built, typechecked, linted, production build passes, and the new Realtime session
was verified end-to-end against the live OpenAI API (both directions). Committed on
`feat/live-voice-readout`. Needs a real dinner/TV field test.

## Why

The 2026-07-07 family test "kinda worked but failed quickly." Root causes found in review:

1. **Web Speech API silently dies.** When a recognition session ends, the restart could throw
   and the code gave up ("rely on user retry") — listening just stopped with the button still lit.
2. **No staleness control.** Slow `/api/live-translate` responses rendered (and were spoken)
   out of order and arbitrarily late.
3. **Wrong tool for ambient audio.** Web Speech is built for one nearby dictating voice, one
   fixed language — not a dinner table, a TV, or mixed EN/ES.

## What was added

### New default engine: **Ambient AI** (the acceptance path)

Continuous mic → WebRTC → GA Realtime session acting as a *silent simultaneous interpreter*:
hears **any language, any number of voices**, and speaks + writes ultra-short micro-summaries in
the target language. No Web Speech, no TTS round-trip — the voice is native streaming audio into
whatever the phone's audio route is (AirPod). Staleness is solved structurally: the prompt says
"if behind, skip old content"; summaries are capped at 120 output tokens; `interrupt_response:
false` + 1-3s summaries keep the ear current.

- [`app/api/live/realtime/route.ts`](../../app/api/live/realtime/route.ts) — mints the ephemeral
  client secret. Model `gpt-realtime-mini` (override: `OPENAI_LIVE_REALTIME_MODEL`), voice
  `marin` (override: `OPENAI_LIVE_REALTIME_VOICE`), server VAD at 450ms silence, input
  transcription on (drives the faint "heard: …" line), output speed 1.15×.
- [`lib/live/ambient.ts`](../../lib/live/ambient.ts) — WebRTC client cloned from the *proven*
  tutor path (`lib/tutor/conversation.ts`). 2h hard cap, 5-min quiet auto-off. "Voice off" just
  mutes the stream — text keeps flowing. `noiseSuppression: false` (it eats far-field TV/dinner
  voices); `echoCancellation: true` (stops the session hearing its own speaker output).
- UI: engine toggle (Ambient AI / On-device), target toggle (→ English / → Español — no
  direction juggling; it hears both), streaming draft card, heard-line, elapsed timer.

**Verified live** (scratchpad WS harness, real API):
- ES audio → EN target: heard correctly; summary *"She's asking if rent was paid, the owner
  hasn't received it."* — first token **~300-500ms after speech stops**.
- EN audio with three direct questions → ES target: *"Ella pregunta por más vino y la cuenta.
  Pregunta la hora ahora."* — stayed in interpreter character, did **not** answer the questions.

### On-device engine hardened (kept as the free fallback)

- **Watchdog:** `onstart`/`onend` track whether the recognizer is actually running; a 4s
  interval rebuilds it whenever it silently died. Listening can no longer stop while lit.
- **Stale milk rules:** lookup results are dropped if >30s old on arrival or if a newer
  utterance already rendered (`STALE_LOOKUP_MS`, seq guard). Queued voice items are skipped at
  play time if >15s old (`STALE_SPEECH_MS`).
- **Interim flush:** if finals lag (common on Android), interim text sitting unchanged for 3s is
  summarized immediately; fuzzy word-prefix dedupe when the real final lands.
- **Faster voice:** `/api/tts` accepts `latency: "flash"` → `eleven_flash_v2_5`
  (override: `ELEVENLABS_FLASH_MODEL`). Only /live sends it; /translate untouched.
- Feed capped at 200 entries; Voice now defaults **ON** (START tap blesses iOS audio).

## Cost & posture notes

- `gpt-realtime-mini` ambient listening ≈ cheap enough for a 2-hour dinner (audio in ~$0.6/hr
  class); session `truncation: "auto"` (API default) bounds context growth. Full `gpt-realtime`
  is one env var away if summary quality needs a bump.
- The mint route is **unauthenticated**, matching the existing /live posture
  (`/api/live-translate`, `/api/tts` are also open). Client caps bound each session, but if the
  bare-domain traffic ever grows, gate it with `getUserFromRequest` like the tutor.

## Field-test checklist (next session)

1. Dinner scenario: phone on table, AirPod in — does VAD chunk sensibly at 450ms? If summaries
   feel choppy, raise `silence_duration_ms` to 600-700; if laggy, drop toward 350.
2. TV/movie: does `noiseSuppression: false` + AGC pick up the soundbar cleanly?
3. Character breaks: if the model ever answers/chats, tighten instructions in
   `buildInterpreterInstructions` (route file) — no client change needed.
4. Cost check after a long session (OpenAI usage dashboard).
