// /demo — "Tu voz" — the numbers, in one place both halves can import.
//
// The browser reads these to draw the timer and stop the recorder; the server
// reads the SAME constants to refuse a sample or a line. A limit that lives in
// two files is two limits the first time somebody edits one of them.
//
// All of them are founders-spike numbers (Tom, 2026-10-24) and every one is
// reversible — see the PR body.

/** Shortest sample worth cloning. ElevenLabs takes less; it sounds like less. */
export const DEMO_MIN_SAMPLE_SECONDS = 10;
/** Longest sample. Past ~a minute instant cloning stops getting better. */
export const DEMO_MAX_SAMPLE_SECONDS = 90;
/** How long a demo voice may live on ElevenLabs before the sweeper takes it. */
export const DEMO_TTL_MS = 10 * 60_000;
/** Spoken lines per demo — enough for "wow", short of a free voice actor. */
export const DEMO_MAX_LINES = 3;
/** Clones one founder may make per UTC day. */
export const DEMO_MAX_CLONES_PER_DAY = 5;
/** Every demo voice is named with this prefix, which is what the sweep keys on. */
export const DEMO_VOICE_PREFIX = "taos-demo-";

/**
 * The share-sheet filename: `TAOS · Spanish · taoslite.com.mp3`.
 *
 * The home screen's share is `TAOS · <lang>.mp3`; the demo's file travels to
 * people who were not on the sidewalk, so it carries the address too.
 */
export function demoShareFileName(languageName: string): string {
  return `TAOS · ${languageName} · taoslite.com.mp3`;
}
