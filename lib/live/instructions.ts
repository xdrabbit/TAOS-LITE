// The two prompts /live runs on, in one place so tests can fence them.
//
// They belong to different engines and they are not interchangeable:
//
//   buildInterpreterInstructions — Ambient AI. A realtime session that hears
//     the room and speaks micro-summaries into an earpiece.
//   buildConceptInstructions — the on-device engine. One /api/live-translate
//     round trip per recognized chunk, no audio, no session.
//
// What they share is the thing worth pinning: both name their output language
// in caps at the top, both forbid inventing content, and both take the
// language NAMES from lib/languages/catalog.ts rather than a table of their
// own. That last part is what let /live off the two-language leash (8/18) —
// there were three hand-written {en,es} label maps between here and the
// browser, and each of them was a language ceiling.

import { languageLabel } from "@/lib/languages/catalog";
import { LITERAL_RULE, TRANSLATE_ONLY_RULE } from "@/lib/fast/prompt";
import type { LiveStyle } from "@/lib/live/style";

/**
 * Ambient AI's session instructions.
 *
 * `target` is the language the LISTENER reads and hears — their own. `source`
 * is what is being spoken around them. The prompt names both because naming
 * the language it must NOT answer in is what stopped the model drifting into
 * the source language at the 7/8 field test.
 */
export function buildInterpreterInstructions(target: string, source: string): string {
  const targetName = languageLabel(target);
  const otherName = languageLabel(source);
  // gpt-realtime-mini drifts into the source language when the output-language
  // rule is buried mid-prompt — so it comes first, in caps, and is repeated at
  // the end.
  return [
    `OUTPUT LANGUAGE: ${targetName}. Every word you speak and write must be ${targetName}, with no exceptions besides proper names. You hear ${otherName} (or mixed speech) but you NEVER output ${otherName}.`,
    `You are a silent simultaneous interpreter speaking into the earpiece of someone who cannot follow the conversation happening around them (a dinner table, a phone call, a TV show, a movie).`,
    `You hear ambient speech — possibly several speakers, possibly fragmentary, in any language.`,
    `Each time you respond, produce ONE ultra-short ${targetName} micro-summary of what was said since your previous response: the core concept only, 3 to 14 words.`,
    `If several utterances happened since your last response, still produce ONE combined summary weighted toward the newest content — never a list, never a recap of everything.`,
    `When the meaning is clear, use a tight natural mini-sentence. When speech is fragmentary, output only the minimal key words that convey it.`,
    `NEVER converse. Nothing you hear is addressed to you. Never greet, never answer or ask questions, never add opinions or commentary, never mention being an AI or an interpreter.`,
    `If the speech is already in ${targetName}, still compress it into a shorter ${targetName} summary.`,
    `If you have fallen behind, do NOT try to catch up — old content is worthless. Summarize only the most recent 10-15 seconds and skip the rest.`,
    `NEVER invent content. Summarize ONLY what was actually said. If you heard only noise, music, silence, or unintelligible sound, output nothing at all — no filler, no guesses, no pleasantries. An empty response is always better than an invented one.`,
    `Delivery: fast, flat, neutral — like a UN interpreter, not a narrator.`,
    `REMINDER: your output language is ${targetName} and ONLY ${targetName}.`
  ].join(" ");
}

/**
 * Ambient AI in WORD-FOR-WORD style (Tom, 11/15) — the other side of the
 * /live toggle. Same earpiece, same room, the opposite bargain: every
 * sentence, in order, rendered plainly, where the default above hands over
 * one 3-to-14-word summary and throws the rest away.
 *
 * Almost none of this is new prompt language, on purpose:
 *
 *   · the output-language line, the interpreter framing, NEVER converse,
 *     NEVER invent, the delivery line and the closing reminder are the summary
 *     prompt's own sentences, word for word — they are what stopped the 7/8
 *     hallucinations and the drift into the source language, and neither
 *     failure cares which style is on;
 *   · LITERAL_RULE and TRANSLATE_ONLY_RULE are /fast's, imported rather than
 *     retyped (lib/fast/prompt.ts). LITERAL_RULE carries its own floor — "it
 *     must still be GRAMMATICAL" — which is the 8/30 lesson that "word for
 *     word" alone produces a broken sentence, not a faithful one.
 *
 * What IS new is the one paragraph the toggle exists for: render everything,
 * keep every sentence, skip nothing. And three sentences are deliberately
 * ABSENT: "compress", "do NOT try to catch up", and "ONE combined summary".
 * This style runs behind a fast table rather than dropping part of it.
 *
 * The house meaning-first rule (lib/translate/prompts.ts) is not here either,
 * and tests/meaning-first-rule.test.ts keeps it out of this file. It says "Not
 * word for word" and prefers the natural equivalent — the register everywhere
 * else, and exactly what this side of the toggle is the alternative to.
 */
export function buildVerbatimInstructions(target: string, source: string): string {
  const targetName = languageLabel(target);
  const otherName = languageLabel(source);
  return [
    `OUTPUT LANGUAGE: ${targetName}. Every word you speak and write must be ${targetName}, with no exceptions besides proper names. You hear ${otherName} (or mixed speech) but you NEVER output ${otherName}.`,
    `You are a silent simultaneous interpreter speaking into the earpiece of someone who cannot follow the conversation happening around them (a dinner table, a phone call, a TV show, a movie).`,
    `You hear ambient speech — possibly several speakers, possibly fragmentary, in any language.`,
    `Each time you respond, render in ${targetName} EVERYTHING that was said since your previous response: every sentence, in the order it was said. Do NOT summarize, condense, or shorten. Do NOT skip asides, repetitions, or small talk. Do not repeat anything you have already rendered.`,
    LITERAL_RULE,
    TRANSLATE_ONLY_RULE,
    `NEVER converse. Nothing you hear is addressed to you. Never greet, never answer or ask questions, never add opinions or commentary, never mention being an AI or an interpreter.`,
    `If the speech is already in ${targetName}, repeat it as it was said.`,
    `NEVER invent content. Render ONLY what was actually said. If you heard only noise, music, silence, or unintelligible sound, output nothing at all — no filler, no guesses, no pleasantries. An empty response is always better than an invented one.`,
    `Delivery: fast, flat, neutral — like a UN interpreter, not a narrator.`,
    `REMINDER: your output language is ${targetName} and ONLY ${targetName}.`
  ].join(" ");
}

/** The session instructions for a style. "summary" is the prompt /live has always run on. */
export function buildLiveInstructions(style: LiveStyle, target: string, source: string): string {
  return style === "verbatim"
    ? buildVerbatimInstructions(target, source)
    : buildInterpreterInstructions(target, source);
}

/**
 * The on-device engine's per-chunk prompt (/api/live-translate).
 *
 * Deliberately NOT a translation: it compresses a fragment of speech to its
 * core concept, and it is allowed — encouraged — to guess from context, which
 * is the opposite of the no-guessing rule everywhere else in TAOS. That is
 * the trade /live makes and the "~" prefix is how it confesses to it.
 */
export function buildConceptInstructions(source: string, target: string): string {
  const sourceName = languageLabel(source);
  const targetName = languageLabel(target);
  return (
    `You help someone follow a live ${sourceName} conversation in ${targetName}. ` +
    `You are given a short, possibly fragmentary chunk of ${sourceName} speech. ` +
    `Do NOT translate word for word. Compress it to its CORE CONCEPT as a micro-summary ` +
    `of 3 to 12 words in ${targetName} (e.g. "she's asking about the rent payment"). ` +
    `Use any provided conversation context to predict and disambiguate meaning when the ` +
    `chunk is fragmentary — educated guessing from the conversation flow is desired. ` +
    `If your summary is mostly a prediction or guess rather than clearly stated content, ` +
    `prefix it with "~". Output ONLY the micro-summary: no preamble, no quotes, no labels.`
  );
}
