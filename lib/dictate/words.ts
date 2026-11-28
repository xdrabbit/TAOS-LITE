// "Our words" — the names and words a person wants spelled their way.
//
// Tom, 2026-11-27: "I have a person that I call Lu, but the spelling is L-U,
// not L-O-U." The list lives on the caller's device (the iOS app keeps it in
// Settings) and travels with every request as `words`: a JSON array of
// strings. This route stores nothing, as before.
//
// The list is used twice:
//   1. a transcription hint, so speech-to-text reaches for "Lu" not "Lou";
//   2. a line in the writer's prompt (dictation and Decoder), so a word the
//      transcriber still got wrong is put right, and a name is never translated.
//
// The words are the caller's own text placed into the caller's own prompt.
// They are still cut down hard: short, few, one line each, no quotes or
// brackets, so a list can only ever read as a list.

export const DICTATE_MAX_WORDS = 50;
export const DICTATE_MAX_WORD_CHARS = 40;

/**
 * A `words` field (a JSON string from a form, or an array from a JSON body)
 * → a clean list. Anything malformed is an empty list, never an error: the
 * dictation matters more than the spelling hint.
 */
export function parseWords(value: unknown): string[] {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const word = item
      .replace(/[\u0000-\u001f\u007f"“”«»<>{}[\]`\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!word || word.length > DICTATE_MAX_WORD_CHARS) continue;
    const key = word.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= DICTATE_MAX_WORDS) break;
  }
  return out;
}

/**
 * For the transcriber. Whisper-family models read `prompt` as text that came
 * before the audio, so a plain list of correctly spelled names is what steers
 * them (OpenAI's own advice for names and jargon).
 */
export function wordsTranscribeHint(words: string[]): string | undefined {
  return words.length ? `Names and words: ${words.join(", ")}.` : undefined;
}

/** For the writer's system prompt. Empty when there is no list. */
export function wordsPromptLine(words: string[]): string {
  if (!words.length) return "";
  return (
    `The speaker's own names and words, spelled the way they spell them: ${words.join(", ")}. ` +
    `Where the text has one of these, or a misspelling the speaker clearly meant as one of ` +
    `these, write it exactly as listed here, and keep it as it is in any language. `
  );
}
