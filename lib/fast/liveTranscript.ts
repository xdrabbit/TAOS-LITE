// Partials, finals, and the one rule that keeps a live mic from costing a
// fortune.
//
// Azure's streaming recogniser emits two kinds of thing, several times a
// second:
//
//   recognizing  a HYPOTHESIS. "where is", "where is the far", "where is the
//                pharmacy" — the same words re-guessed as more audio arrives,
//                each one replacing the last.
//   recognized   a FINAL. That stretch of audio is done being reconsidered.
//
// ── The rule: only finals are text ─────────────────────────────────────────
// A hypothesis is SHOWN and never COMMITTED. It renders as a dimmed tail on
// the input and it does not enter `input` state, which means it does not
// start /fast's 300ms debounce and cannot reach POST /api/fast.
//
// That single line is what makes a live mic affordable on this screen. /fast
// translates as you type, and a hypothesis stream is a fake typist producing
// several "keystrokes" per second: wiring partials into the box would fire a
// translation per guess — dozens of Azure Translator calls per spoken phrase,
// each one billed per character, to render text that was about to be replaced
// anyway. Committing only finals makes it roughly one translation per pause
// for breath, which is the same rate a person typing the phrase would produce.
//
// The MONEY clock is untouched by any of this. A settled input bills one row
// after 1500ms of quiet (lib/fast/settle.ts), however many previews it took,
// and that is as true of a spoken quickie as a typed one — which is the whole
// reason dictation was built to put words in a box rather than to answer.

/** What the recogniser just said. */
export type TranscriptEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "stop" }
  | { type: "cancel" };

export interface TranscriptStep {
  /** The tentative tail to draw after the committed text. "" for none. */
  partial: string;
  /** Text to append to the input box now, or null when nothing settled. */
  commit: string | null;
}

/**
 * Fold one recogniser event into the tail, and say what to commit.
 *
 * `partial` is the tail currently on screen. The interesting cases:
 *
 *   final   clears the tail AND commits. This is the "last final replaces the
 *           partials" rule: the hypothesis and the final describe the SAME
 *           audio, so the tail must vanish in the same step the real text
 *           lands or the phrase is briefly shown twice.
 *   stop    commits whatever tail is left. Azure flushes a final for trailing
 *           audio when recognition stops, so this is normally a no-op — but
 *           when the flush does not arrive (a cancel mid-flight, a socket
 *           that dies on the walk back to the car) the alternative is
 *           dropping words somebody actually said. A tentative last word that
 *           can be edited beats a lost sentence, on a screen with no undo.
 *   cancel  commits nothing. The only event that discards.
 *
 * Empty and whitespace-only finals commit nothing — Azure emits those for
 * silence at the end of a recording.
 */
export function stepTranscript(partial: string, event: TranscriptEvent): TranscriptStep {
  switch (event.type) {
    case "partial":
      return { partial: event.text, commit: null };
    case "final":
      return { partial: "", commit: event.text.trim() || null };
    case "stop":
      return { partial: "", commit: partial.trim() || null };
    case "cancel":
      return { partial: "", commit: null };
  }
}

/**
 * Put dictated words into the box next to whatever is already there.
 *
 * APPENDED, never replacing, and that is the same rule the batch mic shipped
 * with: somebody who typed half a phrase and then said the rest of it has not
 * asked for the typed half to be thrown away, and there is no undo here. Both
 * paths call this so a spoken quickie reads identically whether the words
 * arrived one segment at a time or in one lump.
 *
 * Trimmed and single-spaced at the seam, then capped — the cap is the same
 * FAST_MAX_CHARS the textarea enforces, so dictation cannot put the box into
 * a state typing could not have reached.
 */
export function appendDictated(current: string, addition: string, max: number): string {
  const words = addition.trim();
  if (!words) return current;
  const base = current.trim();
  return (base ? `${base} ${words}` : words).slice(0, max);
}
