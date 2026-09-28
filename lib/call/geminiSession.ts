// The Gemini Live Translate session for /call's evaluation arm: which model,
// what it is told, and where it lives. Shared by the mint route (which locks
// all of it into an ephemeral token) and the client (which only needs the
// socket URL). No secrets here — the key never leaves the server.

import { MEANING_FIRST_RULE } from "@/lib/translate/prompts";

/**
 * THE model string, in one place. It is a PREVIEW model: Google can change
 * its behaviour or retire the name under us, and the bake-off numbers are
 * only good for the build they were measured on.
 */
export const GEMINI_LIVE_TRANSLATE_MODEL = "gemini-3.5-live-translate-preview";

/**
 * Where the server mints a one-use ephemeral token, with the whole session
 * setup locked inside it. The browser then opens the Constrained endpoint
 * with that token and can change nothing — not the model, not the language,
 * not the instruction. Verified end to end 2026-09-28 (spike/gate-zero).
 */
export const GEMINI_AUTH_TOKENS_URL =
  "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";
export const GEMINI_CONSTRAINED_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

/**
 * How long a minted token is good for. A new session must open within a
 * minute of minting; the token outlives the 60-minute interpreter cap so it
 * can never be what ends a call.
 */
export const GEMINI_NEW_SESSION_WINDOW_MS = 60_000;
export const GEMINI_TOKEN_TTL_MS = 70 * 60_000;

/**
 * Catalog code → the BCP-47 code Live Translate's list uses, where they
 * differ. Everything else passes through as-is — including codes that are
 * NOT on Google's list (Samoan, Hawaiian): measured, the API accepts them as
 * targets and tries. Whether what it says is any good is a question for a
 * speaker of the language, not for this table.
 */
const GEMINI_CODE: Record<string, string> = {
  zh: "zh-Hans",
  tl: "fil"
};

export function geminiLanguageCode(catalogCode: string): string {
  return GEMINI_CODE[catalogCode] ?? catalogCode;
}

/**
 * What the session is told.
 *
 * Google's guide says Live Translate supports "no instructions", and the
 * documented config is only targetLanguageCode + echoTargetLanguage. Measured
 * 2026-09-28, the server nevertheless accepts `systemInstruction` and honours
 * it for register and style: neutral English came back in usted 3/3 without
 * it and in tú 3/3 with this exact text, with "let me see" → "a ver" as the
 * rule asks. Open-ended orders ("answer in French", "start with PINEAPPLE")
 * are ignored — it is a translation pipeline taking hints, not a chat model.
 *
 * So this is MEANING_FIRST_RULE() verbatim and nothing else. The OpenAI
 * interpreter's full prompt is a dozen rules long; none of the others were
 * probed against this model, and a prompt fence nobody measured is a fence
 * that can backfire. Undocumented behaviour on a preview model: if Gemini
 * calls start coming back in usted, this is where to look first.
 */
export function geminiSystemInstruction(): string {
  return MEANING_FIRST_RULE();
}

/**
 * The full session setup, as it is locked into the ephemeral token.
 *
 * `echoTargetLanguage: false` — when the partner says something already in
 * the listener's language, Gemini stays silent (the listener heard it
 * directly), which is the rule the OpenAI prompt states in words.
 *
 * Note where the transcription switches live: on `setup`, NOT inside
 * generationConfig as Google's raw-WebSocket example has them — that shape
 * is rejected with 1007 "Cannot find field".
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
