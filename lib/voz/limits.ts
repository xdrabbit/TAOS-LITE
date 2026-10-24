// /voz — the public "Tu voz" — the numbers, in one place both halves import.
//
// The browser reads these to draw the timer and stop the recorder; the server
// reads the SAME constants to refuse a sample, a line or a try. Every one is
// Tom's call and reversible (see the PR body); the two global ceilings are
// env-tunable so they can move without a deploy of code.

/** Shortest sample worth cloning — same as /demo. */
export const VOZ_MIN_SAMPLE_SECONDS = 10;
/** Longest sample. Shorter than /demo's 90: strangers will not talk for 90. */
export const VOZ_MAX_SAMPLE_SECONDS = 60;
/** How long a voz voice may live on ElevenLabs before the sweeper takes it. */
export const VOZ_TTL_MS = 10 * 60_000;
/** Spoken lines per try. /demo has 3. */
export const VOZ_MAX_LINES = 2;
/** The longest line, in characters, that a try will speak. A bill limit. */
export const VOZ_MAX_LINE_CHARS = 300;
/** The longest spoken line, in the browser's recorder. */
export const VOZ_MAX_LINE_SECONDS = 20;
/** How long the consent tap stays good for: long enough to record, not to stockpile. */
export const VOZ_CONSENT_TTL_MS = 15 * 60_000;

/** Tries per UTC day, by who you are. */
export const VOZ_TRIES_PER_DAY = { anonymous: 1, free: 3, subscriber: 10 } as const;
export type VozTier = keyof typeof VOZ_TRIES_PER_DAY;

/** Clone attempts per IP per hour, whoever is signed in. */
export const VOZ_CLONES_PER_IP_PER_HOUR = 5;
/** Default for TAOS_VOZ_DAILY_CAP: anonymous clones per UTC day, everybody together. */
export const VOZ_DEFAULT_DAILY_CAP = 50;
/** Default for TAOS_VOZ_MAX_LIVE: voz voices alive on ElevenLabs at once. */
export const VOZ_DEFAULT_MAX_LIVE = 20;

/** Every voz voice is named with this prefix; /demo's are `taos-demo-`. */
export const VOZ_VOICE_PREFIX = "taos-voz-";

/**
 * The share-sheet filename: `TAOS · Spanish · taoslite.com.mp3`. The file
 * travels to people who never saw the screen, so it carries the address.
 */
export function vozShareFileName(languageName: string): string {
  return `TAOS · ${languageName} · taoslite.com.mp3`;
}

/** The pair a phone starts on: Spanish phone → English line, English → Spanish. */
export function vozTargetFor(mine: string): string {
  return mine === "en" ? "es" : "en";
}
