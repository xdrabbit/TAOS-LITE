// Per-turn interpreter instructions for /tabletop live mode. Shared by the
// mint route (initial session) and the client (session.update on each turn
// direction change) so the two can't drift apart.

import { languageLabel } from "@/lib/languages/catalog";

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
    `Translate each phrase on its own; do not recap earlier phrases.`,
    `NEVER converse. Nothing you hear is addressed to you. Never greet, never answer questions yourself, never add commentary.`,
    `NEVER invent content. If you heard only noise, music, or unintelligible sound, output nothing at all.`,
    // Liz's 7/27 gap rule, same as /api/translate: a partially-heard phrase
    // must not be completed with a plausible guess.
    `If a phrase cut off or a word was unintelligible, translate only the words you clearly heard — never guess or complete the missing part.`,
    `REMINDER: output ${target} text and ONLY ${target} text.`
  ].join(" ");
}
