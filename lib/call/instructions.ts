// Interpreter instructions for /call, as a language PAIR.
//
// This module exists because the prompt used to live inside the mint route
// with `type TargetLang = "en" | "es"` and a two-name lookup table beside it
// — the last hardcoded pair in the app after the 100-language catalog landed
// (commit 1711a3f4), and the reason /call was blacked out for RC1 rather
// than merely held back. A trip on [en, it] got its call interpreted into
// Spanish, confidently and with no error anywhere.
//
// It is shared by the mint route (the session's opening instructions) and by
// the client, which re-sends them through session.update when either phone
// changes its language mid-call. Same reason lib/tabletop/instructions.ts is
// its own file: two copies of a prompt drift, and the drift is invisible
// until someone is standing in a train station.

import { languageLabel } from "@/lib/languages/catalog";

/**
 * One call's interpreting direction, as catalog codes.
 *
 * `source` is what the REMOTE partner speaks — this session hears only them.
 * `target` is what the phone's owner wants to hear. The two phones hold
 * mirror-image directions, which is why each end runs its own session.
 */
export interface CallDirection {
  source: string;
  target: string;
}

export function buildCallInterpreterInstructions(direction: CallDirection): string {
  const targetName = languageLabel(direction.target);
  const otherName = languageLabel(direction.source);
  // Same prompt discipline as /api/live/realtime: the output-language rule
  // first, in caps, and repeated at the end — the model drifts otherwise.
  return [
    `OUTPUT LANGUAGE: ${targetName}. Every word you speak and write must be ${targetName}, with no exceptions besides proper names. You hear ${otherName} but you NEVER output ${otherName}.`,
    `You are a simultaneous phone-call interpreter. You hear exactly ONE person: the remote party of a 1:1 call, speaking ${otherName}.`,
    `Translate everything they say into ${targetName} — faithful and complete, in the FIRST person, as if you were them. Never say "he said" or "she said"; speak AS the speaker.`,
    `Preserve names, numbers, times, and places exactly. Preserve questions as questions.`,
    `NEVER converse. Nothing you hear is addressed to you. Never greet, never answer or ask questions yourself, never add commentary, never mention being an AI or an interpreter.`,
    `If an utterance is already entirely in ${targetName}, output nothing at all — the listener heard it directly.`,
    `If several utterances are waiting, translate them all in order, but keep it tight — no recaps, no repetition of things you already translated.`,
    `If you have fallen far behind, compress the oldest material and translate the newest fully — fresh speech matters most on a live call.`,
    `NEVER invent content. If you heard only noise, silence, or unintelligible sound, output nothing at all — no filler, no guesses.`,
    // Liz's 7/27 gap rule, same as /api/translate and /tabletop.
    `If a phrase cut off or a word was unintelligible, translate only the words you clearly heard — never guess or complete the missing part.`,
    `Delivery: quick, clear, neutral — a professional interpreter, not a narrator.`,
    `REMINDER: your output language is ${targetName} and ONLY ${targetName}.`
  ].join(" ");
}

/**
 * The pair a call ends up interpreting, given what each phone knows.
 *
 * Each phone knows its OWNER's language for certain (the shared pair's
 * `mine`) and learns the partner's over the call's signaling channel. Until
 * that arrives — the first second of a call, or a partner on an older build
 * — it falls back to `theirs` from the local pair, which is this phone's
 * standing guess about who it is talking to and is usually right.
 *
 * The doubled-side rule from lib/translate/pair.ts applies here too: a
 * direction of one repeated language asks the model to interpret a language
 * into itself, and it answers with silence or with parroting. When the two
 * ends genuinely match, there is nothing to interpret — `sameLanguage` says
 * so and the caller skips the session entirely rather than paying for one.
 */
export function resolveCallDirection(
  myLanguage: string,
  partnerLanguage: string | null,
  fallbackPartnerLanguage: string
): CallDirection & { sameLanguage: boolean } {
  const source = partnerLanguage ?? fallbackPartnerLanguage;
  return { source, target: myLanguage, sameLanguage: source === myLanguage };
}
