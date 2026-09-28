# Gate Zero — gemini-3.5-live-translate-preview (2026-09-28)

Throwaway probes (`probe.mjs`, `token-probe.mjs`) run from Node 24 on blackbird
against the live Gemini API over a raw WebSocket, input streamed in real time as
100 ms / 16 kHz / s16le chunks. Test audio was synthesised with gpt-4o-mini-tts
(not a human voice). The WAV/PCM files are not committed.

## 1. Is it steerable?

**Partly — through a field Google says it does not support.** The Live Translate
guide says "no support for tools or instructions", and the only documented knobs
are `translationConfig.targetLanguageCode` and `echoTargetLanguage`. But the
server ACCEPTS `setup.systemInstruction` and, measured, honours it for the two
things TAOS needs:

| input (English → es) | no instruction | with instruction | n |
|---|---|---|---|
| "Could you tell me where the station is? … Let me see…" | **usted** ("¿Me podría…", "¿Sabe…", "Déjeme ver") | TAOS `MEANING_FIRST_RULE("tu")` verbatim → **tú** ("¿Me podrías…", "¿Sabes…") and **"A ver"** | 3/3 each |
| "Hey, can you help me? …" | tú | "always usted" → **usted** | 4/4 |
| "Break a leg… piece of cake" | "Mucha mierda" (meaning-first already) | "word for word, literally" → **"Rómpete una pierna"** | 2/2 |
| "Would you like some coffee? …" | tú | tú rule → tú | 3/3 |
| "Excuse me, sir…" | usted | tú rule → still usted (source marks formality — correct under our own rule) | 3/3 |

Ignored: "begin every translation with PINEAPPLE" (0/1), "always translate into
French" (0/2). It is a translation pipeline that takes register/style hints, not
an LLM that follows arbitrary instructions.

Rejected outright (1007 "Cannot find field"): `translationConfig.register`,
`translationConfig.instructions`. A `clientContent` text turn kills the session
(1011). `speechConfig.voiceConfig` is accepted and has no effect we could hear.

The instruction also survives being locked into a server-minted ephemeral token
(`token-probe.mjs`): tú held.

**Risk:** this is undocumented behaviour on a preview model. It can stop working
without notice, and nothing would error — the call would just start saying usted.

## 2. Samoan?

**Not on the published list.** The list (live-translate guide, last updated
2026-09-16) has 77 codes, and Samoan is not one of them. Neither is Hawaiian or Tongan.

Measured anyway:
- `targetLanguageCode: "sm"` is accepted, and English → Samoan returned
  "Ei, e mafai ona e fesoasoani mai? O fea e te alu i ai i le po nei? Ma e te fia
  sau ma matou?" (plausible to a non-speaker; NOT verified by a Samoan speaker).
- Samoan → English: FAILED on our (synthetic, American-accented) Samoan audio —
  auto-detect called it Tongan (`to`) once and Hawaiian (`haw`) once, and the
  English was garbage. That's weak evidence, because the input wasn't real Samoan speech. But
  the grandfather's case is Samoan IN, which is the direction that failed.

Answer for the product question: not supported, and it can't be promised. It needs a real
Samoan speaker to test before anyone says yes.

## 3. Latency (measured)

Stream start → event, `performance.now()`, Node client, no phone/WebRTC/bridge.

| utterance | speech onset→end | first output text | first voiced audio | last voiced audio | n |
|---|---|---|---|---|---|
| "¿Dónde está el baño?" (1.5 s) | 0.16→1.64 s | 3.14–3.26 s | 3.15–3.44 s | 4.2–4.7 s | 5 |
| 6.3 s Spanish sentence | 0.0→6.3 s | 3.30–3.41 s | 3.32–3.36 s | 8.5–8.8 s | 3 |
| 4.8 s English → es | 0.58→5.34 s | — | 3.7–4.0 s | — | 6 |

Read: about **3.0 s from speech onset** to first translated word, text and audio
arriving within ~10 ms of each other. For a short utterance that is
**~1.5–1.8 s after the speaker stops**. For a long one it starts talking while they
are still speaking and finishes ~2.2–2.5 s after them.

## Also found (matters for the integration)

- **Output streams continuously, silence included, and it is billed.** 60 s of
  pure silence in → 57 s of silent 24 kHz audio out, `usageMetadata` summing
  1450 prompt + 1450 response tokens (25 tok/s each way). So a session costs
  ~$0.0368/min whether anyone talks or not: 1500 × $3.50/M + 1500 × $21/M. That's one
  session per phone, so compare it with the per-phone 3.88¢/min.
- `usageMetadata` arrives every ~2 s carrying a DELTA (50/50 tokens), not a
  running total. Sum them.
- Output chunks are 12000 bytes = 250 ms of 24 kHz s16 mono.
- The raw-WebSocket example in Google's guide is wrong: `inputAudioTranscription`
  / `outputAudioTranscription` belong on `setup`, not `setup.generationConfig`
  (1007 otherwise).
- The server sends `sessionResumptionUpdate` roughly every second.
- **A connection lasts ~10 minutes.** A 16-minute silent run got
  `goAway {timeLeft: "50s"}` at 9m00s and was closed at 9m50s (1008). That's six
  forced reconnects in an hour-long call, so the integration hands over
  make-before-break (see `DRAIN_MS` in lib/call/interpreterGemini.ts). The
  run also billed 14650/14650 tokens for 586 s, which is 25 tok/s each way,
  continuously.
- `promptTokensDetails` TEXT grows over a session (658 → 1375 by 9 min) and is
  NOT included in `promptTokenCount`. The meter bills `promptTokenCount`. If
  Google's invoice runs higher than the meter, this is where to look first.
- `speechConfig.voiceConfig` is accepted and ignored, as far as the transcript
  shows. Google's guide says the model does "voice replication" (it tries to
  sound like the SPEAKER, and can "shift after long pauses, assign the wrong
  gender"). Nobody has listened to it yet: the output PCM was never played to a
  human in this spike.
