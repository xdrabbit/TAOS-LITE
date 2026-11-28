// /dictate's choices, as values both sides of the wire agree on.
//
// Dictate has its own style type on purpose. `Tone` in
// lib/translate/prompts.ts ("casual" | "detailed") means something else, and
// /api/translate parses it — the word "casual" in both is a coincidence, not a
// shared value.
//
// Pure — its one import is the long turn's constants, which are pure too:
// the shell, the route and the prompt builder all import this, and one of
// those runs in the browser.

import { HOME_CHUNK_MS, PRIOR_MAX_CHARS } from "@/lib/translate/longTurn";

export type DictateStyle = "formal" | "professional" | "conversational" | "casual";

export const DICTATE_STYLES: readonly DictateStyle[] = [
  "formal",
  "professional",
  "conversational",
  "casual"
];

/** What a phone that has never chosen gets: the clean work message. */
export const DEFAULT_DICTATE_STYLE: DictateStyle = "professional";

/** The two things the screen does. "decode" is the paste-in reader. */
export type DictateMode = "speak" | "decode";
export const DEFAULT_DICTATE_MODE: DictateMode = "speak";

/** "Same language": the styled text comes back in the language spoken. */
export const DICTATE_SAME_LANGUAGE = "same" as const;

/** Per device, like /live's style (lib/live/style.ts). No per-user table. */
export const DICTATE_STYLE_STORAGE_KEY = "taos.dictate.style";
export const DICTATE_TARGET_STORAGE_KEY = "taos.dictate.target";
export const DICTATE_MODE_STORAGE_KEY = "taos.dictate.mode";

// ── Limits, shared by the browser and the route ────────────────────────────
// A dictation runs up to TEN minutes (Tom, 2026-11-27), recorded the way a
// long home turn is: in chunks of at most DICTATE_CHUNK_MS, each its own
// request (lib/translate/longTurn.ts has the design, and why). One upload of
// ten minutes is not possible here: Vercel refuses a request body over
// 4.5 MB, and a chunk of 4.5 minutes at the recorder's 32 kbps is about
// 1.1 MB — the size home's long turns have been since PR #134.
export const DICTATE_MAX_RECORDING_MS = 600_000;
/** One chunk's longest recording: home's, so the seam behaviour is home's. */
export const DICTATE_CHUNK_MS = HOME_CHUNK_MS;
/**
 * The most chunks one dictation may have, the final one included. The web
 * screen uses three; a client that prefers shorter chunks (the iOS app) has
 * room for one a minute.
 */
export const DICTATE_MAX_CHUNKS = 12;
/**
 * The most the chunk lengths a client reports may add up to: the cap, plus
 * the second or so by which a hard stop can land late. Reported, not
 * measured — the real bounds are the byte cap and the chunk count.
 */
export const DICTATE_MAX_REPORTED_MS = DICTATE_MAX_RECORDING_MS + 30_000;
/** One request's audio. Under Vercel's 4.5 MB body limit with room for the envelope. */
export const DICTATE_MAX_AUDIO_BYTES = 4_000_000;
/** The longest PASTED message the Decoder accepts. */
export const DICTATE_MAX_TEXT_CHARS = 6000;
/**
 * The longest TRANSCRIPT a re-style accepts, and the most the earlier chunks
 * of one dictation may carry. Ten minutes of fast speech is about 12,500
 * characters; this is the long turn's own limit.
 */
export const DICTATE_MAX_TRANSCRIPT_CHARS = PRIOR_MAX_CHARS;

/** Anything that is not one of the four is the default — never an error. */
export function resolveDictateStyle(value: unknown): DictateStyle {
  return DICTATE_STYLES.includes(value as DictateStyle)
    ? (value as DictateStyle)
    : DEFAULT_DICTATE_STYLE;
}

export function resolveDictateMode(value: unknown): DictateMode {
  return value === "decode" ? "decode" : DEFAULT_DICTATE_MODE;
}

/**
 * A stored output language: a language code, or "same". The caller checks the
 * code against the catalog; this only keeps junk out of the request.
 */
export function resolveDictateTarget(value: unknown): string {
  return typeof value === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(value)
    ? value
    : DICTATE_SAME_LANGUAGE;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private mode, or no window at all (the server render).
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* the choice still holds for this visit */
  }
}

export function readStoredDictateStyle(): DictateStyle {
  return resolveDictateStyle(read(DICTATE_STYLE_STORAGE_KEY));
}
export function storeDictateStyle(style: DictateStyle): void {
  write(DICTATE_STYLE_STORAGE_KEY, style);
}

export function readStoredDictateTarget(): string {
  return resolveDictateTarget(read(DICTATE_TARGET_STORAGE_KEY));
}
export function storeDictateTarget(target: string): void {
  write(DICTATE_TARGET_STORAGE_KEY, target);
}

export function readStoredDictateMode(): DictateMode {
  return resolveDictateMode(read(DICTATE_MODE_STORAGE_KEY));
}
export function storeDictateMode(mode: DictateMode): void {
  write(DICTATE_MODE_STORAGE_KEY, mode);
}
