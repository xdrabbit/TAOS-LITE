// Where the scene actually IS — the client's answer to a model that loops.
//
// Field report, 2026-08-27 (Tom, screenshot-verified). A Walk session took
// "Buenos días" correctly five times. The tutor said "Ahora es perfecto.
// Gracias." — and then asked for it again. A "mhm" from the learner sent it
// back to the top a sixth time. The learner never reached the second line of
// a five-line scene.
//
// The cause is structural, not a badly worded prompt. A realtime model holds
// no script state: every turn it re-decides where the scene is from a rolling
// audio context, so "they already said that line" is a fact it must re-derive
// rather than one it keeps. Told to drill a line until it lands, it will drill
// a line that already landed — from inside the conversation the two look the
// same. Prompt wording can make that rarer. It cannot make it impossible, and
// the thing standing between a learner and the rest of the curriculum should
// not be a vibe.
//
// So THE CLIENT OWNS THE SCRIPT POSITION and the model roleplays inside it.
// This file is that position: an ordered list of beats, a pure state machine
// over learner and tutor turns, and the instruction block the client pushes
// back into the live session whenever the position moves. Nothing here touches
// a network, so the rule can be argued with in a test instead of on a phone
// with a microphone and a bill.
//
// Two ways out of every beat, and no third — the same shape Crawl has:
//
//   1. The learner produces the line acceptably → advance. Earned.
//   2. Three attempts at one beat → advance anyway, warmly. Liz's mercy law.
//
// BEAT_MAX_ATTEMPTS is CRAWL_MAX_ATTEMPTS by import and not by coincidence:
// one number, one place, so nobody can tune the drill loose and leave the
// roleplay tight.

import { CRAWL_MAX_ATTEMPTS } from "./crawl";
import type { Lesson } from "./lesson";
import type { TutorModule } from "./modules";
import type { TutorPhase } from "./types";

/** Attempts at one Walk line before the scene moves on regardless. */
export const BEAT_MAX_ATTEMPTS = CRAWL_MAX_ATTEMPTS;

/**
 * Learner turns on one Run checkpoint before it is considered covered.
 *
 * Lower than the Walk cap on purpose. Run is free conversation and its beats
 * are topics, not lines — a checkpoint that took three tries to leave would be
 * a drill wearing a topic's clothes, which is the exact collapse Run is
 * supposed to be safe from.
 */
export const RUN_TURNS_PER_CHECKPOINT = 2;

/**
 * How close the learner has to get. 0-1, see `lineMatchScore`.
 *
 * 0.6 is deliberately generous, and for the same reason CRAWL_PASS_SCORE is
 * 60: this is a rehearsal for ordering coffee, and the transcript arrives via
 * a speech recognizer that drops articles, invents punctuation and mangles
 * proper nouns. The cost of being too strict here is the loop this file
 * exists to kill; the cost of being too loose is that a beat advances a turn
 * early, which the learner experiences as a scene that keeps moving.
 */
export const BEAT_MATCH_THRESHOLD = 0.6;

/**
 * Corrective instructions sent about one beat before the client stops asking
 * and just moves the position itself.
 *
 * Belt and suspenders. The directive below tells the model a beat is done; if
 * it re-drills anyway (models drift, especially late in a session), the client
 * corrects it twice and then advances without its cooperation. The scene's
 * position is not a negotiation.
 */
export const BEAT_MAX_CORRECTIONS = 2;

export type BeatKind = "opening" | "line" | "checkpoint" | "close";

export interface SceneBeat {
  /** Stable within one scene. Used for completion bookkeeping and React keys. */
  id: string;
  kind: BeatKind;
  /** What has to happen here, phrased for the model. */
  goal: string;
  /** The exact target-language line the learner is aiming at, when there is one. */
  target?: string;
  /** What the counterpart just did, in the learner's language. */
  cue?: string;
  /** What the line means, in the learner's language. */
  meaning?: string;
  /** Learner turns spent here before the beat gives up and advances. */
  maxTurns: number;
}

export interface BeatState {
  phase: TutorPhase;
  beats: readonly SceneBeat[];
  /** Index into `beats`. Never past the last one. */
  index: number;
  /** Learner attempts at the CURRENT beat. Acknowledgments do not count. */
  attempts: number;
  /** Corrections issued while on the current beat. */
  corrections: number;
  /** Ids of finished beats, in the order they finished. */
  completed: readonly string[];
  /**
   * Target lines the learner has already produced. The model is told these are
   * finished and must never be requested again — this list IS the anti-loop.
   */
  produced: readonly string[];
  /**
   * Lines the scene moved PAST without the learner landing them — the mercy
   * cap, or a force-advance. Forbidden to the model for the same reason and
   * described differently: saying the learner produced these would be a lie,
   * and a tutor that believes it would stop teaching them.
   *
   * The live run on 2026-08-27 is why this list exists. After a mercy advance
   * the model went on drilling "Buenos días" — correctly, by its own lights,
   * since nobody had ever said it — and the correction path could not see the
   * loop because it was only watching lines that HAD been produced. A learner
   * who cannot say a phrase is the learner most likely to be trapped by it.
   */
  left: readonly string[];
  /** Every beat is done. The scene closes and Run is offered. */
  done: boolean;
}

/** What the machine did with a turn. */
export type BeatAction =
  | "none"
  | "acknowledged"
  | "attempt"
  | "advanced"
  | "mercy-advanced"
  | "corrected"
  | "force-advanced"
  | "scene-complete";

export interface BeatTransition {
  state: BeatState;
  action: BeatAction;
  /**
   * The instruction block to push into the live session (session.update),
   * present only when the position actually moved. Absent means "nothing to
   * tell the model" — a quiet turn must not cost a session update.
   */
  directive?: string;
}

// ── Deriving the beats ─────────────────────────────────────────────────────

/**
 * The scene, as an ordered list.
 *
 * Walk gets the lesson's roleplay: the counterpart's opening, then one beat
 * per learner line in the order the lesson wrote them, then the close. Run
 * gets checkpoints instead of lines — the module's core moves, each with the
 * studied phrase attached as a hint the learner may or may not use. A Run beat
 * is a thing the conversation should pass through, never a line to produce.
 *
 * A Walk with no cached lesson (the realtime route says `lessonAvailable:
 * false`) has no script to hold, so it falls back to the module's core moves
 * the same way Run does. Better a loose scene that moves than a strict one
 * that cannot.
 */
export function deriveBeats(options: {
  phase: TutorPhase;
  lesson?: Lesson | null;
  module?: TutorModule | null;
}): SceneBeat[] {
  const { phase, lesson, module: mod } = options;
  const rp = lesson?.roleplay;

  if (phase === "walk" && rp && rp.learnerLines.length > 0) {
    const beats: SceneBeat[] = [
      {
        id: "opening",
        kind: "opening",
        goal: `Open the scene in character with your first line: "${rp.opening.target}"`,
        target: rp.opening.target,
        cue: rp.opening.cue,
        meaning: rp.opening.meaning,
        maxTurns: 1
      }
    ];
    rp.learnerLines.forEach((line, i) => {
      beats.push({
        id: `line-${i + 1}`,
        kind: "line",
        goal: `Steer the scene so the natural thing for the learner to say is: "${line.target}"${
          line.cue ? ` (after you ${line.cue})` : ""
        }`,
        target: line.target,
        cue: line.cue,
        meaning: line.meaning,
        maxTurns: BEAT_MAX_ATTEMPTS
      });
    });
    beats.push(closeBeat("walk"));
    return beats;
  }

  const moves = (mod?.coreMoves ?? []).slice(0, 5);
  const beats: SceneBeat[] = moves.map((move, i) => {
    const phrase = (lesson?.phrases ?? []).find((p) => p.move === move);
    return {
      id: `topic-${i + 1}-${move}`,
      kind: "checkpoint",
      goal: `Bring the conversation through this, naturally: ${humanizeMove(move)}${
        phrase ? ` — an opening for "${phrase.target}", never demanded verbatim` : ""
      }`,
      target: phrase?.target,
      meaning: phrase?.meaning,
      maxTurns: RUN_TURNS_PER_CHECKPOINT
    };
  });
  // A scene with nothing in it would be "complete" before it began, and the
  // close directive would fire on the tutor's first word.
  if (beats.length === 0) {
    beats.push({
      id: "topic-1",
      kind: "checkpoint",
      goal: lesson?.runGoal || mod?.competency || "an ordinary exchange on this topic",
      maxTurns: RUN_TURNS_PER_CHECKPOINT
    });
  }
  beats.push(closeBeat(phase));
  return beats;
}

function closeBeat(phase: TutorPhase): SceneBeat {
  return {
    id: "close",
    kind: "close",
    goal:
      phase === "walk"
        ? "Close the scene warmly in one sentence — the rehearsal is finished."
        : "Wrap the conversation up warmly in one sentence.",
    maxTurns: 1
  };
}

/** "signal_not_understood" → "signal not understood". Ids are for machines. */
function humanizeMove(move: string): string {
  return move.replace(/[_-]+/g, " ").trim();
}

export function initBeatState(options: {
  phase: TutorPhase;
  lesson?: Lesson | null;
  module?: TutorModule | null;
}): BeatState {
  const beats = deriveBeats(options);
  return {
    phase: options.phase,
    beats,
    index: 0,
    attempts: 0,
    corrections: 0,
    completed: [],
    produced: [],
    left: [],
    done: false
  };
}

export function currentBeat(state: BeatState): SceneBeat | undefined {
  return state.beats[state.index];
}

/**
 * Beats finished, for the progress line on screen and in the directive.
 *
 * Counts only the beats the LEARNER owns. The opening and the close are the
 * tutor's lines, and "0 of 5" on a scene with three learner lines would be the
 * screen counting work nobody has to do.
 */
export function beatProgress(state: BeatState): { done: number; total: number } {
  const owned = state.beats.filter((b) => b.kind === "line" || b.kind === "checkpoint");
  const ids = new Set(owned.map((b) => b.id));
  const done = state.completed.filter((id) => ids.has(id)).length;
  return { done, total: owned.length };
}

// ── Matching what the learner actually said ────────────────────────────────

/**
 * Recognizer output → something two languages' worth of punctuation cannot
 * break. Case, punctuation and Latin/Greek/Cyrillic diacritics go: "dias" has
 * to match "días", because Whisper is inconsistent about accents and the
 * learner did say the word.
 *
 * The order is the whole trick, and getting it wrong ate Hindi in the first
 * draft of this file. NFD splits "í" into i + U+0301, which the first replace
 * removes. Everything still marked as a combining character after that belongs
 * to its script — Devanagari matras, Arabic harakat — and is KEPT, because
 * stripping those does not spell a word more loosely, it spells a different
 * word. (`\p{L}` alone does not match them, which is exactly how they got
 * dropped.)
 */
export function normalizeSpoken(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(normalized: string): string[] {
  return normalized ? normalized.split(" ") : [];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** Same word, allowing for a transcriber's near-miss. */
function wordClose(said: string, target: string): boolean {
  if (said === target) return true;
  if (target.length < 4) return false;
  return levenshtein(said, target) <= (target.length >= 7 ? 2 : 1);
}

/** Longest common subsequence length — the fallback for scripts without spaces. */
function lcs(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = temp;
    }
  }
  return prev[b.length];
}

/**
 * How much of the target line is in what the learner said. 0-1.
 *
 * Coverage of the TARGET, not similarity of the two strings, and the
 * difference matters: a learner who says the line inside a longer sentence
 * ("sí, buenos días señora") has produced the line, and a similarity ratio
 * would punish them for the extra words. Chinese, Japanese and Thai arrive
 * from the recognizer as one long "word", so a target with no spaces falls
 * back to character-subsequence coverage instead of word hits.
 *
 * Both strings are truncated before the quadratic parts run — a two-minute
 * monologue against a six-word line should not cost a phone anything.
 */
export function lineMatchScore(said: string, target: string): number {
  const s = normalizeSpoken(said).slice(0, 400);
  const t = normalizeSpoken(target).slice(0, 120);
  if (!s || !t) return 0;
  if (s.includes(t)) return 1;

  const tWords = words(t);
  if (tWords.length > 1) {
    const sWords = words(s);
    const hits = tWords.filter((tw) => sWords.some((sw) => wordClose(sw, tw))).length;
    return hits / tWords.length;
  }
  return lcs(s, t) / t.length;
}

export function producedLine(said: string, target: string): boolean {
  return lineMatchScore(said, target) >= BEAT_MATCH_THRESHOLD;
}

/**
 * "mhm", "ok", "sí" — a nod with a sound, not a turn.
 *
 * This is half the bug. The looping session restarted on an acknowledgment,
 * because to the model a learner making a small noise after "perfecto" was
 * indistinguishable from one asking to go again. Here an acknowledgment is
 * explicitly not an attempt: it does not count toward the mercy cap, does not
 * advance anything, and does not reset anything.
 *
 * The list is short and Latin-heavy and that is fine, because it is not the
 * safety net — the length rule is. Anything longer than three words is a real
 * turn whatever it contains. And callers must test the current beat's line
 * FIRST: in a module that teaches "yes", "sí" is the target, not a nod.
 */
const ACKNOWLEDGMENTS = new Set([
  "mhm", "mm", "mmm", "mmhm", "hm", "hmm", "uh", "uh huh", "uhhuh", "huh", "ah", "oh",
  "ok", "okay", "k", "yeah", "yep", "yup", "yes", "right", "sure", "got it",
  "si", "claro", "vale", "bueno", "dale", "ya", "aja", "ajam",
  "oui", "ja", "sim", "hai", "嗯", "好", "好的", "是", "对", "はい", "うん"
]);

export function isAcknowledgment(text: string): boolean {
  const normalized = normalizeSpoken(text);
  if (!normalized) return true;
  const parts = words(normalized);
  if (parts.length > 3) return false;
  return parts.every((w) => ACKNOWLEDGMENTS.has(w)) || ACKNOWLEDGMENTS.has(normalized);
}

// ── The state machine ──────────────────────────────────────────────────────

function advance(state: BeatState, produced?: string): BeatState {
  const beat = currentBeat(state);
  if (!beat) return state;
  const completed = [...state.completed, beat.id];
  const nextIndex = Math.min(state.index + 1, state.beats.length - 1);
  const next = state.beats[nextIndex];
  const reachedClose = next?.kind === "close" && nextIndex !== state.index;
  // A line left behind unsaid. Only Walk lines: the opening is the tutor's own
  // line (forbidding it would forbid the scene) and a Run checkpoint's phrase
  // was never demanded in the first place.
  const skipped = !produced && beat.kind === "line" && beat.target ? beat.target : "";
  return {
    ...state,
    index: nextIndex,
    attempts: 0,
    corrections: 0,
    completed,
    produced: produced ? [...state.produced, produced] : state.produced,
    left: skipped ? [...state.left, skipped] : state.left,
    // Landing on the close beat IS the end of the scene: nothing is left for
    // the learner to produce, and the close is the tutor's line to say.
    done: state.done || reachedClose || nextIndex === state.index
  };
}

/**
 * The learner said something. Returns the new position and, when it moved, the
 * directive to push into the session.
 *
 * Order is load-bearing: the current beat's line is tested BEFORE the
 * acknowledgment check, so a module whose target line happens to be "sí" still
 * advances on it.
 */
export function onLearnerTurn(state: BeatState, text: string): BeatTransition {
  if (state.done) return { state, action: "none" };

  // The learner answered before the tutor's opening was registered (or the
  // tutor's transcript never arrived). The opening is the tutor's beat and the
  // learner talking past it is proof enough that it happened.
  let working = state;
  if (currentBeat(working)?.kind === "opening") working = advance(working);
  if (working.done) return { state: working, action: "scene-complete", directive: beatDirective(working) };

  const beat = currentBeat(working);
  if (!beat) return { state: working, action: "none" };

  if (beat.target && producedLine(text, beat.target)) {
    const next = advance(working, beat.target);
    return {
      state: next,
      action: next.done ? "scene-complete" : "advanced",
      directive: beatDirective(next)
    };
  }

  if (isAcknowledgment(text)) {
    // Not an attempt, not a restart, not worth a session update.
    return { state: working, action: "acknowledged" };
  }

  const attempts = working.attempts + 1;
  if (attempts >= beat.maxTurns) {
    const next = advance({ ...working, attempts });
    // Leaving a Run checkpoint after its turns is not mercy, it is the shape
    // of free conversation — only a line the learner owed and did not produce
    // is moved past out of kindness, and only that one gets the framing.
    const mercy = beat.kind === "line";
    return {
      state: next,
      action: next.done ? "scene-complete" : mercy ? "mercy-advanced" : "advanced",
      directive: beatDirective(next)
    };
  }
  return { state: { ...working, attempts }, action: "attempt" };
}

/**
 * The tutor finished a turn. Two jobs.
 *
 * One: the opening beat belongs to the tutor, so its first line completes it.
 *
 * Two: the drift check. If the tutor asks again for a line the learner has
 * already produced, the client corrects it — and after BEAT_MAX_CORRECTIONS
 * corrections about a beat the learner is already working on, it stops asking
 * and advances the position itself. The model can disagree with where the
 * scene is; it cannot win.
 */
export function onTutorTurn(state: BeatState, text: string): BeatTransition {
  if (state.done) return { state, action: "none" };

  if (currentBeat(state)?.kind === "opening") {
    if (!normalizeSpoken(text)) return { state, action: "none" };
    const next = advance(state);
    return {
      state: next,
      action: next.done ? "scene-complete" : "advanced",
      directive: beatDirective(next)
    };
  }

  const redrilled = [...state.produced, ...state.left].find((line) => producedLine(text, line));
  if (!redrilled) return { state, action: "none" };

  const corrections = state.corrections + 1;
  // Force-advancing is only safe once the learner has had a go at the CURRENT
  // beat. A tutor echoing a finished line as praise ("¡Perfecto! Buenos
  // días.") is indistinguishable from one re-drilling it, and skipping a line
  // the learner has not yet tried is a worse bug than the loop — the loop, at
  // least, they can talk their way out of in three turns. When they are trying
  // and the tutor will not move, this is what moves it.
  if (corrections > BEAT_MAX_CORRECTIONS && state.attempts >= 1) {
    const next = advance({ ...state, corrections });
    return {
      state: next,
      action: next.done ? "scene-complete" : "force-advanced",
      directive: beatDirective(next)
    };
  }
  const next = { ...state, corrections };
  return { state: next, action: "corrected", directive: beatDirective(next, redrilled) };
}

// ── What the model is told ─────────────────────────────────────────────────

/**
 * The client-owned script position, as one block of instructions.
 *
 * Pushed with session.update, which REPLACES the session's instructions, so
 * the caller composes this with the persona rather than sending it alone
 * (lib/tutor/conversation.ts holds that rule and the scar that taught it).
 * It is written as an override on purpose: the model's own sense of where the
 * scene is has already been wrong in production, and a directive that reads
 * like a suggestion will lose that argument.
 */
export function beatDirective(state: BeatState, redrilled?: string): string {
  const beat = currentBeat(state);
  const { done, total } = beatProgress(state);

  const finished = state.produced.length
    ? `The learner has ALREADY produced these lines and they are FINISHED — never ask for any of them again, not to check, not to polish, not to confirm: ${state.produced
        .map((l) => `"${l}"`)
        .join(" · ")}.`
    : "";

  // Deliberately not folded into the line above. The model needs to know these
  // are closed WITHOUT being told the learner said them — it would hear the
  // lie in its own next sentence.
  const passed = state.left.length
    ? `The scene has MOVED PAST these lines and they are closed: ${state.left
        .map((l) => `"${l}"`)
        .join(" · ")}. The learner did not land them and that is fine — they are noted for later. Do not teach them, drill them, or ask for them again in this scene.`
    : "";

  if (state.done || beat?.kind === "close") {
    return [
      "SCRIPT POSITION (from the app — authoritative, it overrides your own sense of where the scene is):",
      `Every beat is complete (${total} of ${total}).`,
      finished,
      passed,
      "Close now: one warm sentence, then stop leading. Do not start the scene again and do not ask for another line."
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    "SCRIPT POSITION (from the app — authoritative, it overrides your own sense of where the scene is):",
    `${done} of ${total} beats complete.`,
    finished,
    passed,
    redrilled
      ? `You just asked for "${redrilled}" again. That beat is done. Do not return to it.`
      : "",
    beat ? `CURRENT BEAT — this is the only thing to work toward now: ${beat.goal}` : "",
    "Move forward from here. Never re-open a completed beat."
  ]
    .filter(Boolean)
    .join(" ");
}
