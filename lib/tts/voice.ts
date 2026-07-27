// Cloned-voice selection for /api/tts (ElevenLabs engine). Extracted from the
// route so the rule is PURE and unit-tested — tests/tts-voice.test.ts pins it
// after the 7/24 flip-flop (PR #5 reversed it for an afternoon; PR #6 put it
// back and this module exists so that can never happen silently again).

import type { SupportedLanguageCode } from "@/lib/realtime/languages";

export type TtsLangCode = SupportedLanguageCode;
export type VoiceOverride = "tom" | "liz";

// A multilingual-capable default voice so the same voice reads EN and ES well.
export const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel (multilingual)
// THE IDs BELOW WERE SWAPPED FROM DAY ONE. Verified against the ElevenLabs
// account (GET /v1/voices, 7/27): uOQZ… is the clone NAMED "tom"; tpOaz… is
// the clone NAMED "lizma2". The old labels had them backwards, which stacked
// with the auto-detect routing inversion (fixed in PR #10) to produce the
// #5/#6 flip-flop: the two bugs CANCELLED in auto mode and compounded in
// manual mode, so every one-mode test pointed at the rule instead of the
// data. Do not edit these without re-listing the account's voices.
export const ELEVENLABS_TOM_VOICE = "uOQZaXDzEW5WoyNfLPne"; // account name: "tom"
export const ELEVENLABS_LIZ_VOICE = "tpOaz7u8rY4nup9rRUmh"; // account name: "lizma2"

export function elevenLabsVoiceId(
  sourceLanguage?: TtsLangCode,
  targetLanguage?: TtsLangCode,
  voice?: VoiceOverride
): string {
  // Explicit override wins (kept for flexibility; no screen uses it today).
  if (voice === "tom") return ELEVENLABS_TOM_VOICE;
  if (voice === "liz") return ELEVENLABS_LIZ_VOICE;
  // THE rule, confirmed by Tom in plain words (7/24): the voice follows the
  // SPEAKER. Liz speaks Spanish -> her English translation plays in LIZ's
  // clone (Tom hears Liz's voice speaking English). Tom speaks English -> his
  // Spanish translation plays in TOM's clone (Liz hears Tom's voice speaking
  // Spanish). Do NOT "fix" this to follow the output language again — that
  // was shipped once (PR #5) and reverted the same day.
  //
  // Generalized for new language pairs (7/25, Mandarin): Tom speaks English,
  // so an English SOURCE uses his clone whatever the target — the multilingual
  // TTS model renders his voice in Mandarin just fine. Same for Liz's Spanish.
  // A speaker who is neither of them (e.g. a Mandarin guest) has no clone and
  // falls through to the default multilingual voice.
  if (sourceLanguage === "en" && targetLanguage && targetLanguage !== "en") {
    return ELEVENLABS_TOM_VOICE; // Tom speaking -> translation in Tom's voice
  }
  if (sourceLanguage === "es" && targetLanguage && targetLanguage !== "es") {
    return ELEVENLABS_LIZ_VOICE; // Liz speaking -> translation in Liz's voice
  }
  return process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE;
}
