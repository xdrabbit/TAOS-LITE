# SESSION BRIEF — /live voice readout (2026-07-07)

**STATUS:** Built + gated locally. Pushed on `feat/live-voice-readout` for a Vercel **Preview** build (intentionally NOT promoted to production).

## What was added

`/live` now has an optional **Voice toggle** (pill in the Concepts header) that reads each
micro-summary aloud as it arrives. All in [`components/LiveShell.tsx`](../../components/LiveShell.tsx) —
**no new endpoints, no new env keys.**

- **Reuses the existing `POST /api/tts`** (ElevenLabs, voice-follows-speaker): direction
  `es-en` sends `sourceLanguage: "es", targetLanguage: "en"`, so **Liz's cloned voice reads the
  English concepts** of her Spanish (and Tom's clone reads ES concepts in `en-es`). Mapping is
  the `TTS_LANGS` constant.
- **Anti-lag queue:** concepts queue for speech but only the newest **2** pending are kept
  (`MAX_SPEECH_QUEUE`) — in a live conversation a spoken backlog is worse than a gap; the screen
  already shows everything. Playback is strictly one-at-a-time.
- **iOS unlock:** toggling Voice ON calls `blessAudio()` inside the tap (same trick as
  TranslatorShell) so later programmatic `play()` after the async TTS fetch works on iOS Safari.
- **Guesses are spoken too** (same as shown); failed TTS surfaces as a non-fatal banner and never
  interrupts the feed. Toggle OFF stops current audio and clears the queue.

## Known tradeoff (deliberate v1)

The mic keeps listening while TTS plays. On open speakerphone the recognizer can pick the
readout back up (partially mitigated: recognition lang is the *source* language, TTS speaks the
*target*). UI shows a "headphones/earpiece recommended" hint when Voice is ON. If echo proves
annoying in practice, v2 options: pause recognition during playback (loses live speech — probably
wrong), or timestamp-based suppression of chunks that overlap playback.

## Gate

`npm run typecheck` ✅ `npm run lint` ✅ `npm run build` ✅ (`/live` still in route table).

## Verify on the Preview

Open the Vercel Preview URL → `/live` → toggle **🔊 Voice on** → START LISTENING → speak Spanish
(direction Liz ES→EN). Expect the concept card AND Liz-voice readout within ~1–2 s. Toggle off
mid-playback should cut audio immediately.
