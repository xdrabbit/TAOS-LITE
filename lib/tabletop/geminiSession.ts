// The Gemini Live Translate session the /tabletop brain A/B runs on (Tom,
// 2026-10-21): which model, what it is told, and where it lives. Shared by the
// mint route (which locks all of it into a one-use ephemeral token) and the
// client (which only ever sees the socket URL). No secrets here — the key
// never leaves the server.
//
// Re-aimed from spike/gemini-live-translate @ a2faa41 (lib/call/
// geminiSession.ts, closed PR #70). What changed and why is noted inline; the
// spike's measured facts are in spike/gate-zero/RESULTS.md on that branch.

import { MEANING_FIRST_RULE } from "@/lib/translate/prompts";

/**
 * THE model string, in one place. Re-checked against Google's live-translate
 * guide on 2026-10-21: still `gemini-3.5-live-translate-preview`, still a
 * PREVIEW model, still AUDIO-only output (see buildGeminiSetup). The A/B
 * numbers are only good for the build they were measured on.
 */
export const GEMINI_LIVE_TRANSLATE_MODEL = "gemini-3.5-live-translate-preview";

export const GEMINI_AUTH_TOKENS_URL =
  "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";
export const GEMINI_CONSTRAINED_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

/**
 * A minted token must open its session within a minute. The table mints one
 * per TURN (the target language is locked inside it, and the target flips
 * every time the phone changes hands), so the window only has to cover the
 * mint → socket hop. The overall TTL outlives the 120 s turn cap with room.
 */
export const GEMINI_NEW_SESSION_WINDOW_MS = 60_000;
export const GEMINI_TOKEN_TTL_MS = 10 * 60_000;

/** The friendly fail-closed message. Never a silent fall back to OpenAI. */
export const GEMINI_NOT_CONFIGURED = "Gemini brain not configured";

/**
 * Catalog code → the BCP-47 code Live Translate's list uses, where they
 * differ. Unchanged from the spike.
 */
const GEMINI_CODE: Record<string, string> = {
  zh: "zh-Hans",
  tl: "fil"
};

export function geminiLanguageCode(catalogCode: string): string {
  return GEMINI_CODE[catalogCode] ?? catalogCode;
}

/**
 * What the session is told: MEANING_FIRST_RULE() verbatim and nothing else,
 * exactly as the spike shipped it. Google documents "no instructions" for
 * this model; the spike measured that it honours this one anyway (usted→tú
 * 3/3). The OpenAI table prompt's other rules (never converse, never invent,
 * don't complete a cut-off phrase) were never probed here and are not sent —
 * Live Translate is a pipeline that ignores open-ended orders, so they would
 * be words that do nothing, or worse, a fence nobody measured.
 */
export function geminiSystemInstruction(): string {
  return MEANING_FIRST_RULE();
}

/**
 * The full session setup, as it is locked into the ephemeral token.
 *
 * `responseModalities: ["AUDIO"]` — NOT text. The brief asked for text out
 * only, and the model cannot do it: Google's guide (re-read 2026-10-21) allows
 * AUDIO and nothing else, and every other Live model on the models page is
 * audio-only too. So the table asks for the transcript of the translated
 * speech (`outputAudioTranscription`) and reads THAT as its text, and the
 * audio frames are dropped on the floor unplayed. The voice is still Liz's
 * and Tom's, via /api/tts at turn end, same as OpenAI.
 *
 * The cost of that: Gemini bills the audio it generates whether anyone hears
 * it or not ($21/M out at 25 tok/s — the spike measured silence billing too).
 * est_usd on the [taos-tabletop] line counts it.
 *
 * `echoTargetLanguage: false` — speech already in the listener's language
 * produces nothing, which is what the OpenAI prompt asks for in words.
 *
 * The transcription switches live on `setup`, not inside generationConfig
 * (the spike found Google's raw-WebSocket example wrong: 1007).
 */
export function buildGeminiSetup(target: string): Record<string, unknown> {
  return {
    model: `models/${GEMINI_LIVE_TRANSLATE_MODEL}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      translationConfig: {
        targetLanguageCode: geminiLanguageCode(target),
        echoTargetLanguage: false
      }
    },
    systemInstruction: { parts: [{ text: geminiSystemInstruction() }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {}
  };
}
