// What a caption may show, whatever the engine sent. Pure.
//
// Found at the table on 2026-11-09 (Tom's screenshots, Gemini): the Spanish
// captions carried `<no speech>{pause}` — the model's own way of writing "I
// have nothing to say", sent down the transcript channel as if it were words.
// A leg that is told to keep quiet for one of the two languages produces it
// constantly, so on a two-leg table it landed in the pane of whoever had just
// spoken.
//
// Three places it did harm, and this file is what all three now ask:
//
//   the caption   the marker was printed. stripControlMarkers() removes it.
//   the entry     a transcript that is ONLY markers opened a caption (and, on
//                 the quiet leg, an empty-looking one). hasWords() of the
//                 cleaned text is now what "the interpreter said something"
//                 means, for every dialect in lib/interpreter/legEvents.ts.
//   the idle stop every marker counted as "the interpreter spoke", so a phone
//                 left on the table never went quiet. Same test.
//
// The transcript arrives in fragments, and a marker can be cut anywhere
// ("<no" + " speech>" + "{pa" + "use}"), so this always runs on the
// ACCUMULATED text of a caption, never on one delta — and an opener with no
// closer yet at the very end of the text is held back rather than shown.

/** Nobody says an angle bracket or a brace; a short run inside one is a token. */
const MAX_MARKER_CHARS = 40;

/** `<|endoftext|>`, `<no speech>`, `<noise>`, `<ctrl46>` … */
const ANGLE = new RegExp(`<\\|?[^<>]{0,${MAX_MARKER_CHARS}}\\|?>`, "gu");
/** `{pause}`, `{silence}` … */
const BRACE = new RegExp(`\\{[^{}]{0,${MAX_MARKER_CHARS}}\\}`, "gu");
/** An opener the next fragment will close: held back while it is the tail. */
const OPEN_TAIL = new RegExp(`(?:<[^<>]{0,${MAX_MARKER_CHARS}}|\\{[^{}]{0,${MAX_MARKER_CHARS}})$`, "u");

// Square brackets and parentheses CAN be speech-adjacent text, so those are
// removed only around a closed vocabulary of non-speech annotations — the
// ones transcribers and audio models are known to write.
const ANNOTATIONS = [
  "no speech",
  "no_speech",
  "nospeech",
  "no audio",
  "silence",
  "silent",
  "pause",
  "pausa",
  "silencio",
  "sin voz",
  "noise",
  "ruido",
  "background noise",
  "music",
  "música",
  "musica",
  "inaudible",
  "unintelligible",
  "ininteligible",
  "blank audio",
  "blank_audio",
  "static",
  "crosstalk",
  "breath",
  "breathing",
  "cough",
  "coughing",
  "laughs",
  "laughter",
  "risas",
  "sound",
  "sounds",
  "beep"
];
const ANNOTATION = new RegExp(
  `[\\[(]\\s*(?:${ANNOTATIONS.map((a) => a.replace(/[_ ]/g, "[_ ]")).join("|")})\\s*[\\])]`,
  "giu"
);

/**
 * `[friendly]`, `[neutral]`, `[silent]` — the delivery tags an ElevenLabs
 * voice model is steered with. Its Realtime tier writes them into the
 * transcript of what it "said" (probe, 2026-11-09); nobody hears them and
 * nobody should read them. One or two lower-case words in square brackets —
 * a bracketed Capitalised name or a number is left alone.
 */
const DELIVERY_TAG = /\[[a-z]{2,16}(?: [a-z]{2,16})?\]/gu;
/**
 * …and the same tag while it is still arriving: "[neu" + "tral]". Held back
 * while it is the tail of the text, like OPEN_TAIL — without this a response
 * that was only `[neutral] <silent>` opened the speaker and left "[neutral"
 * on the screen for good (probe, 2026-11-09: the full text has no words, so
 * the caption that the fragment opened was never finished or corrected).
 */
const OPEN_DELIVERY_TAIL = /\[[a-z]{0,16}(?: [a-z]{0,16})?$/u;

/**
 * The text with every control / silence marker taken out. Idempotent, and
 * safe on text that has none (it comes back unchanged apart from whitespace
 * left by a removed marker).
 */
export function stripControlMarkers(text: string): string {
  if (!text) return "";
  // The common case, and the only one for most engines: nothing to do.
  if (!/[<>{}[\]()]/.test(text)) return text;
  const stripped = text
    .replace(ANGLE, " ")
    .replace(BRACE, " ")
    .replace(ANNOTATION, " ")
    .replace(DELIVERY_TAG, " ")
    .replace(OPEN_TAIL, "")
    .replace(OPEN_DELIVERY_TAIL, "");
  if (stripped === text) return text;
  return stripped
    .replace(/[ \t ]{2,}/g, " ")
    // A removed marker must not leave " ." or " ," behind.
    .replace(/ +([.,;:!?…])/g, "$1")
    .replace(/^[ \t]+/, "")
    .replace(/[ \t ]+$/u, "");
}

/** Is there anything a person could read — a letter or a digit? */
export function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** Did the interpreter (or a speaker) actually SAY something here? */
export function spokenWords(text: string): string {
  const clean = stripControlMarkers(text);
  return hasWords(clean) ? clean : "";
}

// ── An echo is not an interpretation ───────────────────────────────────────
// ElevenLabs Realtime is a cascade (transcriber → language model → voice),
// and its language model always answers. A leg that should have kept quiet —
// it heard its OWN output language — sometimes says the sentence back instead
// ("Sale, pero me da cosa dejar a…" → "De acuerdo, pero me da miedo dejar
// a…", in the same language, aloud). On that engine the words of a response
// arrive BEFORE its audio, so the client can refuse to play one: a response
// whose words are mostly the words it just heard is a repetition, whatever
// the model meant by it.
//
// Language-agnostic on purpose (the catalog has a hundred languages and no
// language detector): a real interpretation shares almost no WORDS with its
// source — names, numbers and the odd cognate — and a repetition shares most.

function wordTokens(text: string): string[] {
  return (text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** The share of `said`'s words that were in `heard`, 0..1, counting repeats once each. */
export function echoOverlap(said: string, heard: string): number {
  const saidTokens = wordTokens(said);
  if (!saidTokens.length) return 0;
  const pool = new Map<string, number>();
  for (const t of wordTokens(heard)) pool.set(t, (pool.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of saidTokens) {
    const left = pool.get(t) ?? 0;
    if (left > 0) {
      shared += 1;
      pool.set(t, left - 1);
    }
  }
  return shared / saidTokens.length;
}

/** At or above this share of repeated words, a response is a repetition. */
export const ECHO_OVERLAP = 0.6;

export function looksLikeEcho(said: string, heard: string): boolean {
  const clean = stripControlMarkers(said);
  if (!hasWords(clean) || !hasWords(heard)) return false;
  return echoOverlap(clean, heard) >= ECHO_OVERLAP;
}

/**
 * `text` without its first `count` words (and the punctuation after them).
 * Used to take the OTHER person's previous sentence off the front of what a
 * leg reports hearing, when the provider glued two utterances together.
 */
export function dropLeadingWords(text: string, count: number): string {
  if (count <= 0) return text;
  let seen = 0;
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    seen += 1;
    if (seen === count) {
      return text.slice((m.index ?? 0) + m[0].length).replace(/^[\s.,;:!?…"'”’)\]]+/u, "");
    }
  }
  return "";
}

/**
 * If `heard` begins with all of `earlier` — word for word, ignoring case,
 * accents and punctuation — and goes on, return the rest; otherwise `heard`.
 */
export function withoutLeadingRepeat(heard: string, earlier: string): string {
  const a = wordTokens(heard);
  const b = wordTokens(earlier);
  if (b.length < 2 || a.length <= b.length) return heard;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return heard;
  return dropLeadingWords(heard, b.length);
}
