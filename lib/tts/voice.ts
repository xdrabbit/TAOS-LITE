// Cloned-voice selection for /api/tts (ElevenLabs and Fish Audio engines). Extracted from the
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

// LIZ'S VOICE IS CONFIGURATION NOW, NOT CODE — read the story before changing
// this, because it is the second time the ID moved and the first move was
// wrong.
//
// 8/23, PR #32: swapped tpOaz… ("lizma2") → atyoq… ("lizma5") because Liz's
// voice had been "re-made". Every API check passed — the ID resolved, the
// account named it, real Spanish audio came back 200 — and it was still the
// WRONG VOICE. GET /v1/voices/atyoq… says category "generated": lizma5 is an
// ElevenLabs Voice Design synthesised from the text prompt "…Venezuelan
// accent with a San Cristobal vicinity focus…", not a retrain of Liz's
// recordings. A prompt-built stranger with the right accent passes every
// automated check a clone does. Only Tom's ears could tell, and they did.
//
// 8/23, this PR: rolled back to tpOaz… ("lizma2", category "cloned",
// description "liz better") — the familiar voice — and moved the value OUT of
// code into ELEVENLABS_LIZ_VOICE_ID so the next retrain is a Vercel dashboard
// edit plus a redeploy instead of a PR. The account holds a whole Liz lineage
// (Lizma, lizma2, Lizma 3, lizma4, lizma5) and the API cannot tell you which
// one sounds like her, so whoever sets that variable owes it an ears-test.
export const ELEVENLABS_LIZ_VOICE_ENV = "ELEVENLABS_LIZ_VOICE_ID";

/** The stock multilingual voice: env override, else the built-in default. */
export function defaultElevenLabsVoiceId(): string {
  return process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE;
}

/**
 * Liz's personal voice, from the environment.
 *
 * There is deliberately NO hardcoded fallback ID. A stale constant is exactly
 * how the wrong voice shipped and stayed shipped: it sounds like a person, so
 * nothing downstream can flag it. If the variable is missing we say so in the
 * server log and hand back the stock multilingual voice — obviously not Liz to
 * anyone listening, and loud in the Vercel runtime logs for anyone reading.
 */
export function lizElevenLabsVoiceId(): string {
  const configured = process.env[ELEVENLABS_LIZ_VOICE_ENV]?.trim();
  if (configured) return configured;
  console.error(
    `[tts/voice] ${ELEVENLABS_LIZ_VOICE_ENV} is not set — Liz's personal voice is unavailable, ` +
      `falling back to the stock multilingual voice (${defaultElevenLabsVoiceId()}). ` +
      `Set ${ELEVENLABS_LIZ_VOICE_ENV} to her ElevenLabs voice id in Vercel (Production and Preview) and redeploy.`
  );
  return defaultElevenLabsVoiceId();
}

/**
 * The personal-voice GATE, which sits in front of the speaker rule below.
 *
 * `unlocked` devices (Tom's and Liz's phones, which sent the right
 * TAOS_PERSONAL_VOICE_CODE — see lib/tts/personalVoice.ts) behave exactly as
 * TAOS always has. Everyone else resolves to the default multilingual voice,
 * silently: no error, no hint the clones exist. The explicit "tom"/"liz"
 * override is gated too — it is a request for a clone like any other.
 */
export function gatedElevenLabsVoiceId(
  unlocked: boolean,
  sourceLanguage?: TtsLangCode,
  targetLanguage?: TtsLangCode,
  voice?: VoiceOverride
): string {
  if (!unlocked) return defaultElevenLabsVoiceId();
  return elevenLabsVoiceId(sourceLanguage, targetLanguage, voice);
}

export function elevenLabsVoiceId(
  sourceLanguage?: TtsLangCode,
  targetLanguage?: TtsLangCode,
  voice?: VoiceOverride
): string {
  // An explicit override wins (speakerClone checks it first; no screen uses it today).
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
  const who = speakerClone(sourceLanguage, targetLanguage, voice);
  if (who === "tom") return ELEVENLABS_TOM_VOICE; // Tom speaking -> translation in Tom's voice
  if (who === "liz") return lizElevenLabsVoiceId(); // Liz speaking -> translation in Liz's voice
  return defaultElevenLabsVoiceId();
}

/**
 * WHOSE clone a line should play in — the speaker rule above with the
 * provider taken out, so ElevenLabs and Fish Audio can never disagree about
 * it. `null` is "nobody's": a guest, or a same-language echo.
 */
export function speakerClone(
  sourceLanguage?: TtsLangCode,
  targetLanguage?: TtsLangCode,
  voice?: VoiceOverride
): VoiceOverride | null {
  if (voice) return voice;
  if (sourceLanguage === "en" && targetLanguage && targetLanguage !== "en") return "tom";
  if (sourceLanguage === "es" && targetLanguage && targetLanguage !== "es") return "liz";
  return null;
}

// ── Fish Audio (10/06) ─────────────────────────────────────────────────────
// A second home for the same two clones, trained on Fish Audio
// (fish.audio, account models "Tom" and "Lizma"). Configuration, like Liz's
// ElevenLabs id above, for the same reason: a retrain is a dashboard edit.
//
// The value must be the model's 32-hex `_id`, NOT its title. The first setup
// put the titles ("Tom", "Lizma") in these variables; Fish answers a title
// with an error, so a non-id value is reported in the log and treated as
// unset rather than sent.
export const FISHAUDIO_TOM_VOICE_ENV = "FISHAUDIO_TOM_VOICEID";
export const FISHAUDIO_LIZ_VOICE_ENV = "FISHAUDIO_LIZ_VOICEID";

const FISH_MODEL_ID = /^[0-9a-f]{32}$/;

function fishVoiceFromEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[tts/voice] ${name} is not set — no Fish Audio clone for this speaker.`);
    return null;
  }
  if (!FISH_MODEL_ID.test(value)) {
    console.error(
      `[tts/voice] ${name} is not a Fish Audio model id (got a ${value.length}-character value; ` +
        `expected 32 hex characters — the model's _id, not its title). Treating it as unset.`
    );
    return null;
  }
  return value;
}

/**
 * The Fish Audio clone for this line, or `null` when there isn't one to use:
 * a locked phone, a speaker who is neither Tom nor Liz, or a variable that is
 * missing or malformed. The route turns `null` into the ElevenLabs stock
 * voice — Fish has no account-level "default voice" worth trusting blind.
 */
export function gatedFishAudioVoiceId(
  unlocked: boolean,
  sourceLanguage?: TtsLangCode,
  targetLanguage?: TtsLangCode,
  voice?: VoiceOverride
): string | null {
  if (!unlocked) return null;
  const who = speakerClone(sourceLanguage, targetLanguage, voice);
  if (who === "tom") return fishVoiceFromEnv(FISHAUDIO_TOM_VOICE_ENV);
  if (who === "liz") return fishVoiceFromEnv(FISHAUDIO_LIZ_VOICE_ENV);
  return null;
}
