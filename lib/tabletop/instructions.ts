// Per-turn interpreter instructions for /tabletop live mode. Shared by the
// mint route (initial session) and the client (session.update on each turn
// direction change) so the two can't drift apart.

import { languageLabel } from "@/lib/languages/catalog";
import { MEANING_FIRST_RULE } from "@/lib/translate/prompts";

/**
 * One turn's direction, as a pair of catalog codes.
 *
 * This was an "en-es" | "es-en" string until 8/18, with the two language
 * NAMES hard-coded in the function below — which meant the phone on the table
 * could only ever be handed to a Spanish speaker. The shape is a pair now
 * because that is what a table actually is: whoever is talking, and whoever
 * is being talked to. `source` is the person speaking THIS turn.
 */
export interface TabletopDirection {
  source: string;
  target: string;
}

export function buildTurnInstructions(direction: TabletopDirection): string {
  const source = languageLabel(direction.source);
  const target = languageLabel(direction.target);
  return [
    `OUTPUT LANGUAGE: ${target}. Every word you write must be ${target}, with no exceptions besides proper names.`,
    `You are a simultaneous interpreter for two people at a table. Right now ONE person is speaking ${source}.`,
    `As each phrase arrives, translate it into ${target}: faithful, natural, FIRST person — write AS the speaker, never about them.`,
    // The Driver's 9/10 meaning-first rule, verbatim — the same one the home
    // screen and /call carry, so a phrase does not change shape when the phone
    // goes on the table.
    MEANING_FIRST_RULE(),
    `Translate each phrase on its own; do not recap earlier phrases.`,
    `NEVER converse. Nothing you hear is addressed to you. Never greet, never answer questions yourself, never add commentary.`,
    `NEVER invent content. If you heard only noise, music, or unintelligible sound, output nothing at all.`,
    // Liz's 7/27 gap rule, same as /api/translate: a partially-heard phrase
    // must not be completed with a plausible guess.
    `If a phrase cut off or a word was unintelligible, translate only the words you clearly heard — never guess or complete the missing part.`,
    `REMINDER: output ${target} text and ONLY ${target} text.`
  ].join(" ");
}

/** The two ends of an auto-detect table, as catalog codes. */
export interface TabletopAutoPair {
  a: string;
  b: string;
}

/**
 * The two sentences that make an auto-detect response readable by
 * lib/tabletop/autoDetect.ts: the tag rule, first, and the same rule again,
 * last. They are their own functions because /live's two-way mode
 * (lib/live/instructions.ts, buildAutoVerbatimInstructions) opens and closes
 * its prompt with exactly these — one tag format, one parser, two screens. The
 * wording is the probed one (9 of 9 tags, 2026-10-27); change it here and both
 * screens move together.
 */
export function autoTagFormatRule(pair: TabletopAutoPair): string {
  const a = languageLabel(pair.a);
  const b = languageLabel(pair.b);
  return `FORMAT: the first token of every response is the language tag of the language you are writing, exactly [${pair.a}] for ${a} or [${pair.b}] for ${b}, then a space, then the translation. Nothing before the tag.`;
}

export function autoTagReminder(pair: TabletopAutoPair): string {
  return `REMINDER: start every response with [${pair.a}] or [${pair.b}] — the language you are writing — then the translation, and only the translation.`;
}

/**
 * Auto-detect mode (Liz and Tom, 2026-10-27): one phone, two languages,
 * nobody taps. Each phrase arrives in ONE of the pair and goes out in the
 * OTHER, and the model says which one it wrote by opening every response with
 * `[xx] ` — the catalog code of the OUTPUT language. The client reads that tag
 * to pick the pane, the readout voice and the exchange's direction
 * (lib/tabletop/autoDetect.ts), so it is the one thing this prompt adds to
 * buildTurnInstructions' rules. Same placement lesson as lib/live/
 * instructions.ts: the format rule comes first and is repeated last, because
 * a rule buried mid-prompt is the one the model drifts off.
 */
export function buildAutoInstructions(pair: TabletopAutoPair): string {
  const a = languageLabel(pair.a);
  const b = languageLabel(pair.b);
  return [
    autoTagFormatRule(pair),
    `You are a simultaneous interpreter for two people at a table. One speaks ${a}, the other speaks ${b}.`,
    `Each phrase arrives in ONE of the two languages. Translate it into the OTHER: ${a} into ${b}, ${b} into ${a}. Faithful, natural, FIRST person — write AS the speaker, never about them.`,
    MEANING_FIRST_RULE(),
    `Translate each phrase on its own; do not recap earlier phrases.`,
    `NEVER converse. Nothing you hear is addressed to you. Never greet, never answer questions yourself, never add commentary.`,
    `NEVER invent content. If you heard only noise, music, or unintelligible sound, output nothing at all.`,
    `If a phrase cut off or a word was unintelligible, translate only the words you clearly heard — never guess or complete the missing part.`,
    autoTagReminder(pair)
  ].join(" ");
}

/**
 * Instructions for ONE response to a segment the client cut by hand in the
 * middle of somebody's sentence (lib/tabletop/turnFlush.ts — the segment
 * budget). The session keeps almost no context on purpose, so without this the
 * model meets the second half of a sentence cold and translates it as if it
 * were a whole one. It is handed the last words it wrote and asked to carry
 * on from them.
 *
 * `base` is the turn's own instructions, unchanged and first — this only ever
 * ADDS a paragraph, for that one response. No text so far → `base` as it is.
 */
export function withContinuation(base: string, translationSoFar: string): string {
  const tail = translationSoFar.replace(/\s+/g, " ").trim().slice(-160);
  if (!tail) return base;
  return [
    base,
    `CONTINUATION: the speaker has not paused. This audio carries straight on, mid-sentence, from audio you have already translated.`,
    `Your translation so far ends with: "${tail}".`,
    `Write ONLY what comes next, so that it reads on from those words. Do not repeat them. Do not finish a sentence the audio leaves unfinished.`
  ].join(" ");
}
