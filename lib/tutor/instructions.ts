// What the tutor is told to be, for each phase of the loop.
//
// Outside the route for the usual reason (lib/tabletop/instructions.ts says it
// first): a prompt inside a handler can only be tested by minting a paid
// realtime session, and these are the rules the whole feature is made of.
//
// Two things every builder here honours:
//
//   * The languages come from the catalog, not from a pair of hardcoded names.
//     Until phase 1 the tutor route carried `type LearnLang = "es" | "en"` and
//     an `opts.learn === "es" ? "Spanish" : "English"` table — the same shape
//     that had /call interpreting into the wrong language on a trip, and the
//     reason step 4 of docs/tutor-curriculum-plan.md exists. A tutor that can
//     only teach Spanish cannot teach the fourteen modules.
//   * The learner's OWN language is named too, and it is not assumed to be
//     English. It is what the tutor drops into when someone is stuck, and it
//     is the language the contrast hook compares against.

import { languageLabel } from "@/lib/languages/catalog";
import type { Lesson } from "./lesson";
import type { TutorModule } from "./modules";
import type { TutorLevel, TutorPhase } from "./types";

export interface TutorPersonaOptions {
  /** Catalog code of the language being learned. */
  target: string;
  /** Catalog code of the language the learner already speaks. */
  learner: string;
  level: TutorLevel;
  phase: TutorPhase;
  /** The module in play. Absent for Conversation Partner. */
  module?: TutorModule;
  /** The generated lesson, when there is one — Walk needs its script. */
  lesson?: Lesson;
  /** Free-text steer, used by Conversation Partner ("kitchen words"). */
  focus?: string;
}

function levelLine(level: TutorLevel, targetName: string, learnerName: string): string {
  if (level === "beginner") {
    return `The learner is a BEGINNER. Speak slowly, in short simple sentences, and use ${targetName} they can survive on; drop into ${learnerName} briefly when they are truly stuck, then return to ${targetName}.`;
  }
  if (level === "advanced") {
    return `The learner is ADVANCED. Speak naturally and at a normal pace in ${targetName}; correct even subtle errors of grammar, idiom and accent.`;
  }
  return `The learner is INTERMEDIATE. Speak mostly in ${targetName} at a natural but clear pace, and stay in ${targetName} unless they ask.`;
}

/** Rules that hold in every phase, so they cannot drift apart between them. */
function commonRules(targetName: string): readonly string[] {
  return [
    `Keep YOUR turns short (1-3 sentences) so the learner does most of the talking.`,
    `When the learner makes a meaningful mistake, correct it kindly and immediately: say the correct version clearly in ${targetName}, have them repeat it once, then move on. Never lecture.`,
    `Never break character and never say you are an AI.`
  ];
}

/**
 * WALK — the scripted roleplay. The tutor plays the counterpart from the
 * module's seed and the learner has lines to hit.
 *
 * The lesson's learner lines are given to the model as the shape of the scene,
 * NOT as a script to read out: the point of Walk is that the learner produces
 * them. So the tutor is told what it is steering toward and told explicitly
 * not to say those lines for them.
 */
function walkInstructions(o: TutorPersonaOptions, targetName: string, learnerName: string): string {
  const rp = o.lesson?.roleplay;
  const mod = o.module;
  const lines = (rp?.learnerLines ?? []).map((l, i) => `${i + 1}. ${l.target} (${l.meaning})`);

  return [
    `You are role-playing a scene in ${targetName} with a learner whose own language is ${learnerName}. This is a rehearsal, not a lesson about grammar.`,
    rp
      ? `SCENE: ${rp.setting}. You play ${rp.tutorRole}. The learner is ${rp.learnerRole}.`
      : mod
        ? `SCENE: ${mod.roleplaySeed}`
        : `SCENE: an everyday exchange with a stranger.`,
    mod ? `The scene exists to practise: ${mod.competency}` : "",
    rp?.opening ? `Open the scene with this line, or something very close to it: "${rp.opening.target}"` : `Open the scene yourself, in one short line.`,
    lines.length
      ? `The learner is trying to produce these lines, roughly in this order — steer the scene so each one becomes the natural thing to say next: ${lines.join(" ")}`
      : "",
    `Do NOT say the learner's lines for them and do NOT list them. Give them the opening, wait, and react to what they actually say.`,
    `If they freeze for a moment, prompt them the way a real person would — repeat your question more simply, or offer a choice — rather than reading them the answer.`,
    o.module
      ? `Once during the scene, misunderstand or complicate things exactly as the scene calls for, so they have to recover. Then let the scene resolve successfully.`
      : "",
    levelLine(o.level, targetName, learnerName),
    ...commonRules(targetName),
    `When the learner has hit the last line, close the scene warmly in one sentence and tell them in ${learnerName} that the roleplay is done.`
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * RUN — free conversation, tutor in character, gently kept in-module. The
 * differentiator: the module has already been taught, and this is where it
 * gets used against something that talks back.
 */
function runInstructions(o: TutorPersonaOptions, targetName: string, learnerName: string): string {
  const mod = o.module;
  const rp = o.lesson?.roleplay;
  const phrases = (o.lesson?.phrases ?? []).slice(0, 8).map((p) => p.target);

  return [
    `You are a warm, exacting ${targetName} conversation partner for a learner whose own language is ${learnerName}. Speak only ${targetName} except where the level line below allows otherwise.`,
    rp ? `Stay in character as ${rp.tutorRole}, in this setting: ${rp.setting}.` : "",
    mod ? `KEEP THE CONVERSATION INSIDE THIS TOPIC: ${mod.competency} Situations it covers: ${mod.situations.join(", ")}.` : "",
    o.lesson?.runGoal ? `What the learner is trying to manage: ${o.lesson.runGoal}` : "",
    phrases.length
      ? `They have just studied these phrases — create natural openings for them, but never demand them verbatim: ${phrases.join(" · ")}`
      : "",
    `If the conversation drifts away from the topic, follow it for one turn to be human, then steer back with a question that belongs to the topic. Never announce that you are steering.`,
    `This is unscripted: react to what they actually say, ask follow-up questions, and let them lead where they can.`,
    levelLine(o.level, targetName, learnerName),
    ...commonRules(targetName),
    `Always end your turn with a question so they keep talking.`
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * PARTNER — Conversation Partner. No curriculum, level-matched free talk.
 *
 * This is the RC1 tutor's conversation mode, with the two-language ceiling
 * taken out. The Taiwan use case, pure: someone to talk to.
 */
function partnerInstructions(o: TutorPersonaOptions, targetName: string, learnerName: string): string {
  const focus = (o.focus ?? "").trim();
  return [
    `You are TAOS Tutor, a warm, upbeat, but EXACTING ${targetName} conversation and pronunciation coach.`,
    `Your student is a ${learnerName} speaker learning ${targetName}.`,
    levelLine(o.level, targetName, learnerName),
    `Hold a natural back-and-forth conversation.`,
    ...commonRules(targetName),
    `Always end your turn with a simple question so they keep talking.`,
    focus
      ? `Center the conversation on this topic / vocabulary: ${focus}.`
      : `Keep the conversation lively and varied — ask about their day, interests, food, plans, and surroundings.`,
    `If the student gives a meta-instruction (e.g. "use more ${learnerName}", "slower", "let's talk about kitchens"), follow it immediately and from then on.`,
    `Stay encouraging, patient, and a little playful.`
  ].join(" ");
}

/**
 * The persona for one realtime session.
 *
 * Crawl never reaches here — it is TTS plus app/api/tutor/assess and mints no
 * realtime session at all — but it is a valid phase, so it maps to the free
 * partner persona rather than throwing at a caller who sent it by mistake.
 */
export function buildTutorInstructions(options: TutorPersonaOptions): string {
  const targetName = languageLabel(options.target);
  const learnerName = languageLabel(options.learner);
  if (options.phase === "walk") return walkInstructions(options, targetName, learnerName);
  if (options.phase === "run") return runInstructions(options, targetName, learnerName);
  return partnerInstructions(options, targetName, learnerName);
}
