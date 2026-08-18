// The personal-voice gate: who is allowed to be heard in Tom's or Liz's
// CLONED voice. Everyone else — every stranger who scans the QR code on the
// trip — gets the stock multilingual voice instead.
//
// The gate is SERVER-side by design. The clone IDs live in lib/tts/voice.ts
// and never leave the server; an unauthorized client cannot name one, because
// /api/tts takes a speaker direction (not a voice id) and resolves the clone
// only after this check passes. The header below is the whole key material:
// a shared secret Tom sets as TAOS_PERSONAL_VOICE_CODE in Vercel and types
// once per phone.
//
// Isomorphic on purpose — no node: or browser globals — so the route, the
// unlock endpoint, the client helper and the tests all share one definition.

/** Sent by unlocked devices on every TTS request. */
export const PERSONAL_VOICE_HEADER = "x-taos-voice-key";

/** localStorage key holding the code on an unlocked phone. */
export const PERSONAL_VOICE_STORAGE_KEY = "taos.personalVoiceCode";

// Constant-time string compare: always walks the full length and folds the
// length difference into the accumulator, so timing leaks neither the code
// nor how many leading characters a guess got right.
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    // Past the end charCodeAt is NaN, and NaN || 0 === 0 — a fixed stand-in
    // that keeps the loop length independent of the inputs.
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * True when `provided` matches the configured secret. Fails CLOSED: an unset
 * or blank TAOS_PERSONAL_VOICE_CODE unlocks nobody, so a preview deployment
 * that is missing the env var quietly serves default voices rather than
 * handing the clones to everyone.
 */
export function personalVoiceUnlocked(
  provided: string | null | undefined,
  expected: string | null | undefined
): boolean {
  const secret = expected?.trim() ?? "";
  const given = provided?.trim() ?? "";
  if (!secret || !given) return false;
  return timingSafeEqual(given, secret);
}
