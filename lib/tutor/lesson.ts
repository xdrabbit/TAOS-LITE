// Lesson generation: (module, target language, learner language) → a lesson.
//
// The prompt and the parser live here, outside the route, for the same reason
// buildInstructions and elevenLabsVoiceId do — this is the part with rules in
// it, and rules that only exist inside a route handler can only be tested with
// a phone and a credit card.
//
// ── What the model is actually asked for ───────────────────────────────────
// A module (lib/tutor/modules.ts) is an INTENT, not a script. The generator's
// job is to instantiate that intent in the target language and, in the same
// breath, say where the target language builds it differently from the
// language the learner already thinks in. That second half is the contrast
// hook, and it is the lesson's headline rather than a footnote:
//
//   EN learner → ES target : "quiero agua" maps word-for-word. Say so.
//   EN learner → HI target : "मुझे पानी चाहिए" is to-me water is-wanted.
//   ES learner → FA target : verb last, and taarof softens the whole request.
//
// The same module, three completely different teaching moments. Note that the
// contrast is against the LEARNER's language, not against English: for Liz
// learning Hindi the interesting comparison is with Spanish, and an English
// baseline would be teaching her someone else's lesson.
//
// A lesson is expensive to make and identical for everyone who asks for the
// same three inputs, so it is generated once and cached (lib/tutor/lessonStore.ts).
// Repeat visits must be free — this is a premium feature that has to survive
// contact with a monthly bill.

import { languageLabel, canSpeak } from "@/lib/languages/catalog";
import type { PronunciationTarget, TutorModule } from "./modules";

/**
 * Bump when the prompt or the required shape below changes.
 *
 * It is part of the cache key, so a bump retires every stored lesson instead
 * of serving yesterday's shape to today's parser. Cheap: the cache refills
 * itself one lesson at a time, as people open modules.
 */
export const LESSON_PROMPT_VERSION = 1;

export interface LessonPhrase {
  /** Which of the module's coreMoves this phrase performs. */
  move: string;
  /** The phrase, in the target language, in its own script. */
  target: string;
  /** Latin-script pronunciation, for scripts the learner cannot read yet. */
  romanization?: string;
  /** What it means, in the LEARNER's language. */
  meaning: string;
  /** Word-for-word gloss. Present when the structure differs — the receipt. */
  literal?: string;
  /** One short usage note: register, when to use it, what it is not. */
  note?: string;
}

export interface LessonContrastHook {
  /** One line, in the learner's language. The teaching moment, up front. */
  headline: string;
  /** Two to four sentences on how the target builds this intent. */
  explanation: string;
  /** The contrast made concrete: one phrase, glossed word for word. */
  example?: LessonPhrase;
  /**
   * The honest escape hatch. When the two languages really do build this the
   * same way (EN→ES for most modules), the model says so instead of inventing
   * a difference — a fabricated contrast is worse than no contrast, because
   * the learner cannot tell which lessons to trust.
   */
  sameAsLearner: boolean;
}

export interface LessonPronunciationItem {
  /** The module slot this fills (lib/tutor/modules.ts). */
  slot: PronunciationTarget;
  /** The exact string Crawl sends to Azure as the reference text. */
  phrase: string;
  romanization?: string;
  meaning?: string;
  /** What to listen for — the sound the learner's own language will fight. */
  why?: string;
}

export interface LessonRoleplayLine {
  /** What the counterpart just did, so the learner knows when this line lands. */
  cue: string;
  target: string;
  romanization?: string;
  meaning: string;
}

export interface LessonRoleplay {
  setting: string;
  /** Who the tutor plays. Drives the Walk realtime persona. */
  tutorRole: string;
  learnerRole: string;
  /** The counterpart's first line, so Walk opens without a silent pause. */
  opening: LessonRoleplayLine;
  /** The lines the learner is trying to hit, in order. */
  learnerLines: readonly LessonRoleplayLine[];
}

export interface Lesson {
  moduleId: string;
  /** Catalog code of the language being learned. */
  target: string;
  /** Catalog code of the language the learner already speaks. */
  learner: string;
  title: string;
  contrastHook: LessonContrastHook;
  phrases: readonly LessonPhrase[];
  pronunciation: readonly LessonPronunciationItem[];
  roleplay: LessonRoleplay;
  /** What a successful free-conversation (Run) turn looks like. */
  runGoal: string;
  /** Provenance, so a cached lesson can say where it came from. */
  model?: string;
  generatedAt?: string;
  promptVersion?: number;
}

/**
 * The cache key. Module × target × learner, exactly as the plan specifies —
 * level is deliberately NOT in it, because level changes how the tutor SPEAKS
 * (lib/tutor/instructions.ts), not which phrases the module teaches. Three
 * copies of every lesson to say the same sentences more slowly would be three
 * times the generation bill for nothing.
 */
export function lessonCacheKey(moduleId: string, target: string, learner: string): string {
  return `${moduleId}:${target}:${learner}:v${LESSON_PROMPT_VERSION}`;
}

/**
 * The generation prompt.
 *
 * Kept as one exported function so tests can read what the model is being told
 * without minting a completion — the same fence tests/live-instructions.ts and
 * tests/tabletop-instructions.ts put around the streaming prompts.
 */
export function buildLessonPrompt(options: {
  module: TutorModule;
  target: string;
  learner: string;
}): { system: string; user: string } {
  const { module: mod, target, learner } = options;
  const targetName = languageLabel(target);
  const learnerName = languageLabel(learner);
  const textOnly = !canSpeak(target);

  const system = [
    `You write survival-language lessons for adult travelers. You are writing ONE lesson: the intent module "${mod.title}" instantiated in ${targetName}, for a learner whose own language is ${learnerName}.`,
    `The learner is an adult on a trip, not a student in a classroom. Everything you write must be usable out loud, today, by someone with no grammar vocabulary.`,
    `Write every explanation, meaning and note in ${learnerName}. Write every phrase to be SAID in ${targetName}, in that language's own script.`,
    // The whole reason the curriculum is language-agnostic. See the header.
    `THE CONTRAST HOOK IS THE LESSON'S CENTRE. Compare how ${targetName} builds this intent with how ${learnerName} builds it, and lead with the difference. Do not compare against English unless English IS the learner's language.`,
    `If ${targetName} and ${learnerName} genuinely build this intent the same way, set sameAsLearner to true and say plainly that it maps across — never invent a difference to fill the field. A made-up contrast teaches the learner to distrust the real ones.`,
    `Use the register a polite stranger would use. Where a language marks formality, teach the form that is safe with a stranger and say what the familiar form would change.`,
    `Never transliterate ${learnerName} words into ${targetName} sentences, and never teach a phrase you would not say yourself.`,
    `Respond with JSON only — no prose, no markdown fences.`
  ].join(" ");

  const romanizationRule = textOnly
    ? // Tier 2 (lib/languages/catalog.ts): the app cannot speak this language,
      // so the written page is the only teacher the learner gets. The
      // romanization stops being a convenience and becomes the pronunciation.
      `${targetName} is TEXT ONLY in this app — the learner will never hear it spoken by the tutor's voice. Give a romanization for EVERY phrase, plus a plain-language hint for any sound ${learnerName} does not have.`
    : `Give a romanization for every phrase written in a non-Latin script; omit it when ${targetName} already uses the Latin alphabet.`;

  const user = [
    `MODULE: ${mod.title} (id: ${mod.id})`,
    `COMPETENCY: ${mod.competency}`,
    `SITUATIONS: ${mod.situations.join(", ")}`,
    `CORE MOVES (teach one phrase per move, in this order): ${mod.coreMoves.join(", ")}`,
    mod.contrastHook
      ? `CONTRAST FOCUS — check whether this applies to ${targetName} vs ${learnerName}, and ignore it entirely if it does not: ${mod.contrastFocus}`
      : `This module has nothing structural to contrast; set sameAsLearner to true.`,
    `ROLEPLAY SEED (the Walk scene; the tutor will play the counterpart): ${mod.roleplaySeed}`,
    `PRONUNCIATION SLOTS — fill each with the exact phrase from your phrase list that a scorer should hear: ${mod.pronunciationTargets.join(", ")}`,
    romanizationRule,
    "",
    "Return exactly this JSON shape:",
    JSON.stringify(
      {
        title: `short lesson title, in ${learnerName}`,
        contrastHook: {
          headline: `one line, in ${learnerName}`,
          explanation: `2-4 sentences, in ${learnerName}`,
          sameAsLearner: false,
          example: {
            move: "one of the core moves",
            target: `phrase in ${targetName}`,
            romanization: "if the script is not Latin",
            meaning: `in ${learnerName}`,
            literal: "word-for-word gloss showing the structure"
          }
        },
        phrases: [
          {
            move: "core move id",
            target: `phrase in ${targetName}`,
            romanization: "if the script is not Latin",
            meaning: `in ${learnerName}`,
            literal: "word-for-word gloss, when the structure differs",
            note: "one short usage note, optional"
          }
        ],
        pronunciation: [
          {
            slot: mod.pronunciationTargets[0],
            phrase: "the exact target-language phrase to score",
            romanization: "if the script is not Latin",
            meaning: `in ${learnerName}`,
            why: `the sound a ${learnerName} speaker will get wrong`
          }
        ],
        roleplay: {
          setting: "where this happens",
          tutorRole: "who the tutor plays",
          learnerRole: "who the learner is",
          opening: {
            cue: "the scene opens",
            target: `the counterpart's first line, in ${targetName}`,
            romanization: "if the script is not Latin",
            meaning: `in ${learnerName}`
          },
          learnerLines: [
            {
              cue: `what the counterpart just said or did, in ${learnerName}`,
              target: `the line the learner should say, in ${targetName}`,
              romanization: "if the script is not Latin",
              meaning: `in ${learnerName}`
            }
          ]
        },
        runGoal: `one sentence, in ${learnerName}: what the learner should manage in free conversation`
      },
      null,
      2
    ),
    "",
    `Give one phrase per core move (${mod.coreMoves.length} phrases), one entry per pronunciation slot, and 4-6 learner lines in the roleplay.`
  ].join("\n");

  return { system, user };
}

// ── Parsing ────────────────────────────────────────────────────────────────
// A lesson that half-arrived is not a lesson. The parser throws rather than
// returning something partly-shaped, because the caller's alternative — cache
// it and serve it forever — is the expensive kind of wrong.

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalStr(value: unknown): string | undefined {
  const s = str(value);
  return s ? s : undefined;
}

function toPhrase(raw: unknown): LessonPhrase | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const target = str(r.target);
  const meaning = str(r.meaning);
  if (!target || !meaning) return null;
  return {
    move: str(r.move) || "phrase",
    target,
    romanization: optionalStr(r.romanization),
    meaning,
    literal: optionalStr(r.literal),
    note: optionalStr(r.note)
  };
}

function toLine(raw: unknown): LessonRoleplayLine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const target = str(r.target);
  if (!target) return null;
  return {
    cue: str(r.cue),
    target,
    romanization: optionalStr(r.romanization),
    meaning: str(r.meaning)
  };
}

export class LessonParseError extends Error {}

/**
 * Model JSON → a Lesson, or an exception naming what was missing.
 *
 * Unknown pronunciation slots are dropped rather than trusted: Crawl scores
 * against the module's declared targets, and a slot the module never asked for
 * would put a phrase on the drill card that nothing else in the lesson knows
 * about.
 */
export function parseLesson(
  raw: unknown,
  context: { module: TutorModule; target: string; learner: string }
): Lesson {
  const parsed: unknown = typeof raw === "string" ? safeJson(raw) : raw;
  if (!parsed || typeof parsed !== "object") {
    throw new LessonParseError("The lesson generator did not return JSON.");
  }
  const r = parsed as Record<string, unknown>;

  const hookRaw = (r.contrastHook ?? {}) as Record<string, unknown>;
  const headline = str(hookRaw.headline);
  const explanation = str(hookRaw.explanation);
  if (!headline || !explanation) {
    throw new LessonParseError("The lesson came back without its contrast hook.");
  }

  const phrases = Array.isArray(r.phrases)
    ? r.phrases.map(toPhrase).filter((p): p is LessonPhrase => p !== null)
    : [];
  if (phrases.length < 3) {
    throw new LessonParseError("The lesson came back with too few phrases.");
  }

  const allowedSlots = new Set<string>(context.module.pronunciationTargets);
  const pronunciation: LessonPronunciationItem[] = (
    Array.isArray(r.pronunciation) ? r.pronunciation : []
  )
    .map((item): LessonPronunciationItem | null => {
      if (!item || typeof item !== "object") return null;
      const p = item as Record<string, unknown>;
      const slot = str(p.slot);
      const phrase = str(p.phrase);
      if (!allowedSlots.has(slot) || !phrase) return null;
      return {
        slot: slot as PronunciationTarget,
        phrase,
        romanization: optionalStr(p.romanization),
        meaning: optionalStr(p.meaning),
        why: optionalStr(p.why)
      };
    })
    .filter((p): p is LessonPronunciationItem => p !== null);
  if (pronunciation.length === 0) {
    throw new LessonParseError("The lesson came back with nothing to pronounce.");
  }

  const rpRaw = (r.roleplay ?? {}) as Record<string, unknown>;
  const opening = toLine(rpRaw.opening);
  const learnerLines = (Array.isArray(rpRaw.learnerLines) ? rpRaw.learnerLines : [])
    .map(toLine)
    .filter((l): l is LessonRoleplayLine => l !== null);
  if (!opening || learnerLines.length < 2) {
    throw new LessonParseError("The lesson came back without a usable roleplay.");
  }

  return {
    moduleId: context.module.id,
    target: context.target,
    learner: context.learner,
    title: str(r.title) || context.module.title,
    contrastHook: {
      headline,
      explanation,
      example: toPhrase(hookRaw.example) ?? undefined,
      sameAsLearner: hookRaw.sameAsLearner === true
    },
    phrases,
    pronunciation,
    roleplay: {
      setting: str(rpRaw.setting) || context.module.situations[0],
      tutorRole: str(rpRaw.tutorRole) || "the counterpart in the scene",
      learnerRole: str(rpRaw.learnerRole) || "the traveler",
      opening,
      learnerLines
    },
    runGoal: str(r.runGoal) || context.module.competency,
    promptVersion: LESSON_PROMPT_VERSION
  };
}

function safeJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
