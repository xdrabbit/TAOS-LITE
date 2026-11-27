// /dictate's choices, as values both sides of the wire agree on.
//
// Dictate has its own style type on purpose. `Tone` in
// lib/translate/prompts.ts ("casual" | "detailed") means something else, and
// /api/translate parses it — the word "casual" in both is a coincidence, not a
// shared value.
//
// Pure and dependency-free: the shell, the route and the prompt builder all
// import this, and one of those runs in the browser.

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
// One recording per dictation, one request. Two minutes at the recorder's
// 32 kbps is about 480 KB; an iPhone that ignores the bitrate hint and records
// AAC at four times that is still under 2 MB. The byte cap sits below Vercel's
// 4.5 MB request-body limit with room for the multipart envelope.
export const DICTATE_MAX_RECORDING_MS = 120_000;
export const DICTATE_MAX_AUDIO_BYTES = 4_000_000;
/**
 * The longest text the JSON requests accept (a re-style's transcript, or a
 * pasted message). Two minutes of fast speech is about 2,500 characters; a
 * long run of pasted texts is rarely more than this.
 */
export const DICTATE_MAX_TEXT_CHARS = 6000;

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
