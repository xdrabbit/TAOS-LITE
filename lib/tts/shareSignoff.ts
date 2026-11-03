// The spoken sign-off on a shared line (Tom, 2026-10-24).
//
// The home card's Share hands the recipient a playable mp3. For a free-tier
// sender, and only while TAOS_SHARE_SIGNOFF=1, that file ends with a short
// "Traducido con TAOS" / "Translated with TAOS" in Google's Kore voice:
//
//   [line][150 ms silence][sign-off]   — one mp3, joined here on the server
//
// The rules, each pinned in tests/share-branding.test.ts:
//   * Share only. The Play path never asks, and the route never appends
//     unless the request asked (body `signoff: true`) from surface home-share.
//   * Never for a subscriber, and never when the flag is off. When the tier
//     cannot be read, the answer is the clean file — a paying user must never
//     be branded because a lookup failed.
//   * Appended, never prepended. Nobody waits through a jingle to hear the line.
//   * Best effort: any failure here returns the clean line. A sign-off is
//     never a reason for a share to fail.
//
// The two phrases are new copy, pending Liz's review (pendiente de revisión
// por Liz). Any language other than Spanish hears the English one.

import type { TtsLangCode } from "./voice";
import { decodeGoogleAudio, synthesizeGoogle, type GoogleVoice } from "./google";
import { audioFrames, frameBytes, joinMp3, paddingFrames } from "./mp3";

export { SIGNOFF_AVAILABLE_HEADER, SIGNOFF_HEADER } from "./signoffHeaders";

export const SIGNOFF_GAP_MS = 150;

export function shareSignoffEnabled(value = process.env.TAOS_SHARE_SIGNOFF): boolean {
  return value?.trim() === "1";
}

export interface SignoffPhrase {
  lang: "es" | "en";
  text: string;
  voice: GoogleVoice;
}

/** What the sign-off says for a target language. */
export function signoffPhrase(target: TtsLangCode | string | null | undefined): SignoffPhrase {
  return target === "es"
    ? { lang: "es", text: "Traducido con TAOS", voice: { languageCode: "es-US", voiceName: "es-US-Chirp3-HD-Kore" } }
    : { lang: "en", text: "Translated with TAOS", voice: { languageCode: "en-US", voiceName: "en-US-Chirp3-HD-Kore" } };
}

/** Synthesizes one sign-off at a sample rate; injectable for tests. */
export type SignoffSynth = (phrase: SignoffPhrase, sampleRate: number) => Promise<Uint8Array | null>;

async function googleSynth(phrase: SignoffPhrase, sampleRate: number): Promise<Uint8Array | null> {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) return null;
  const res = await synthesizeGoogle(phrase.text, phrase.voice, apiKey, fetch, sampleRate);
  if (!res.ok) return null;
  const payload = (await res.json().catch(() => null)) as { audioContent?: unknown } | null;
  const audio = decodeGoogleAudio(payload?.audioContent);
  return audio ? new Uint8Array(audio) : null;
}

// One clip per phrase per sample rate, synthesized once per server instance.
// A failure is not cached: the next share tries again.
const clipCache = new Map<string, Promise<Uint8Array | null>>();

export function clearSignoffCache(): void {
  clipCache.clear();
}

/** The sign-off's audio frames, Google's padding silence trimmed off both ends. */
export function signoffClip(
  target: string | null | undefined,
  sampleRate: number,
  synth: SignoffSynth = googleSynth
): Promise<Uint8Array | null> {
  const phrase = signoffPhrase(target);
  const key = `${phrase.lang}:${sampleRate}`;
  const cached = clipCache.get(key);
  if (cached) return cached;
  const pending = synth(phrase, sampleRate)
    .then((raw) => {
      if (!raw) return null;
      const frames = audioFrames(raw);
      if (frames.length === 0 || frames[0].sampleRate !== sampleRate) return null;
      const { lead, trail } = paddingFrames(raw, frames);
      return frameBytes(raw, frames.slice(lead, frames.length - trail));
    })
    .catch(() => null)
    .then((clip) => {
      if (!clip) clipCache.delete(key);
      return clip;
    });
  clipCache.set(key, pending);
  return pending;
}

/** The line's sample rate, or null when it does not parse as Layer III. */
export function lineSampleRate(line: Uint8Array): number | null {
  return audioFrames(line)[0]?.sampleRate ?? null;
}

/**
 * [Xing][line][silence][sign-off] as one stream, or null when the two cannot be
 * joined safely (unparseable line, or a sign-off at a different rate).
 */
export function appendSignoff(line: Uint8Array, clip: Uint8Array): Uint8Array | null {
  return joinMp3([line, clip], SIGNOFF_GAP_MS);
}

/** Tier lookup, injectable for tests. Resolves true when it cannot tell. */
export type SubscriberLookup = (userId: string) => Promise<boolean>;

export async function subscriberFromProfile(userId: string): Promise<boolean> {
  try {
    const { supabaseAdmin, hasServiceRoleKey } = await import("@/lib/supabaseAdmin");
    if (!hasServiceRoleKey) return true;
    const { tierFromProfile } = await import("@/lib/tutor/meter");
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("subscription_status, tier")
      .eq("id", userId)
      .maybeSingle();
    if (error) return true;
    return tierFromProfile(data as { subscription_status?: string; tier?: string } | null) !== "free";
  } catch {
    return true;
  }
}

export interface SignoffDecision {
  /** The request asked for a sign-off (surface home-share, body signoff). */
  requested: boolean;
  userId: string | null;
  target: string | null;
}

/**
 * The sign-off step, applied to a finished line. Returns the audio to send
 * and whether it carries a sign-off. Never throws.
 */
export async function withSignoff(
  line: Uint8Array,
  decision: SignoffDecision,
  deps: { enabled?: boolean; isSubscriber?: SubscriberLookup; synth?: SignoffSynth } = {}
): Promise<{ audio: Uint8Array; signed: boolean; skipped: string | null }> {
  const clean = (skipped: string | null) => ({ audio: line, signed: false, skipped });
  try {
    if (!decision.requested) return clean(null);
    if (!(deps.enabled ?? shareSignoffEnabled())) return clean(null);
    if (!decision.userId) return clean(null);
    if (await (deps.isSubscriber ?? subscriberFromProfile)(decision.userId)) return clean(null);
    const rate = lineSampleRate(line);
    if (!rate) return clean("signoff_unparsed");
    const clip = await signoffClip(decision.target, rate, deps.synth);
    if (!clip) return clean("signoff_synth");
    const joined = appendSignoff(line, clip);
    return joined ? { audio: joined, signed: true, skipped: null } : clean("signoff_join");
  } catch {
    return clean("signoff_exception");
  }
}
