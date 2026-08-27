// When Crawl lets go of a phrase.
//
// Liz was the first person outside this repo to walk the curriculum, and the
// first thing she hit was the wall: Crawl's Say-It step kept her on the same
// phrase, asking for a pronunciation she was not going to produce today. Her
// words were "close enough, move on".
//
// She is right, and the reason she is right is what this file encodes. Crawl
// is the cheap warm-up before Walk and Run — the point of it is to get the
// shape of the phrase into the mouth, not to certify it. A learner who cannot
// leave a phrase never reaches the roleplay, which is where the language
// actually gets used. So there are two ways out and no third:
//
//   1. Score the threshold → advance. Earned.
//   2. Three attempts under it → advance anyway, warmly, and mark the phrase
//      for review so the miss is remembered instead of being enforced.
//
// No phrase can trap anyone. That is the whole rule.
//
// ── Which number is the gate ───────────────────────────────────────────────
// Azure's assessment (app/api/tutor/assess/route.ts) returns five numbers per
// attempt, all 0-100:
//
//   AccuracyScore     — phoneme accuracy against the reference
//   FluencyScore      — pacing and pausing
//   CompletenessScore — how much of the reference was actually said
//   ProsodyScore      — intonation and stress (en-US only)
//   PronScore         — Microsoft's weighted aggregate of the above
//
// The gate is **PronScore**, surfaced by the route as `pron`. It is the number
// already shown to the learner as "Pronunciation" and already stored as
// `bestScore` (lib/tutor/progress.ts), so gating on anything else would mean
// advancing on a number the screen never displayed — arbitrary, which is the
// exact feeling this change exists to remove.
//
// `accuracy` is the documented fallback, and only that: PronScore is absent
// when Azure returns a partial assessment, and in that case phoneme accuracy
// is the closest honest stand-in. Neither present → no verdict at all, and the
// learner keeps the manual Next button they have always had.

import type { TutorLevel } from "./types";

/**
 * Close enough, in a number.
 *
 * 60 is deliberately low. Azure hands out 60s for a phrase that is
 * comprehensible with an accent, and comprehensible-with-an-accent is the
 * entire goal of a survival curriculum — Tom ordering coffee in Taipei does
 * not need an 85. Tune it here; it is the one place.
 */
export const CRAWL_PASS_SCORE = 60;

/**
 * The bar rises with the level the learner chose for themselves.
 *
 * Beginner keeps the default. Someone who set the tutor to Advanced is asking
 * to be pushed, and honouring that is not the same as trapping them — the
 * attempt cap below applies identically at every level, so Advanced means
 * "three tries at 80" and never "stuck at 80".
 */
export const CRAWL_PASS_SCORES: Readonly<Record<TutorLevel, number>> = {
  beginner: CRAWL_PASS_SCORE,
  intermediate: 70,
  advanced: 80
};

/**
 * How many scored attempts a phrase gets before Crawl moves on regardless.
 *
 * Three is the number in Liz's complaint, roughly: the same phrase "over and
 * over". One retry can feel like a fluke correction, two is a fair second
 * look, and by the third the learner has heard the model, tried, been coached
 * and tried again. Past that it is repetition, not practice.
 */
export const CRAWL_MAX_ATTEMPTS = 3;

export function crawlPassScore(level: TutorLevel): number {
  return CRAWL_PASS_SCORES[level] ?? CRAWL_PASS_SCORE;
}

/**
 * What happened on this attempt.
 *
 *   passed    — met the bar, move on, say well done
 *   retry     — under the bar with attempts left, stay and try again
 *   moving-on — under the bar out of attempts, move on anyway and remember it
 */
export type CrawlVerdict = "passed" | "retry" | "moving-on";

export interface CrawlOutcome {
  verdict: CrawlVerdict;
  /** The score the verdict was reached on, rounded the way the screen shows it. */
  score: number;
  /** The bar this attempt was measured against. */
  threshold: number;
  /** Scored attempts on this phrase INCLUDING this one. */
  attempts: number;
  /** Attempts remaining before the cap moves the learner on. 0 once it has. */
  attemptsLeft: number;
  /** Leave this phrase now? True for both ways out. */
  advance: boolean;
  /** Remember this phrase as unfinished business (phase 2 surfaces it). */
  markForReview: boolean;
}

/**
 * The overall pronunciation number for an attempt, or null if Azure did not
 * give one. See the header for why `pron` first and `accuracy` second.
 */
export function crawlScore(result: {
  pron?: number | null;
  accuracy?: number | null;
} | null | undefined): number | null {
  const pron = result?.pron;
  if (typeof pron === "number" && Number.isFinite(pron)) return pron;
  const accuracy = result?.accuracy;
  if (typeof accuracy === "number" && Number.isFinite(accuracy)) return accuracy;
  return null;
}

/**
 * Score + attempt number → what Crawl does next.
 *
 * Pure, so the rule can be argued with in a test instead of on a phone with a
 * microphone. `attempts` is 1-based and counts this attempt.
 */
export function crawlOutcome({
  score,
  attempts,
  level = "beginner",
  maxAttempts = CRAWL_MAX_ATTEMPTS
}: {
  score: number;
  attempts: number;
  level?: TutorLevel;
  maxAttempts?: number;
}): CrawlOutcome {
  const threshold = crawlPassScore(level);
  const rounded = Math.round(score);
  const attempt = Math.max(1, Math.round(attempts));
  const passed = rounded >= threshold;
  const outOfAttempts = attempt >= maxAttempts;

  return {
    verdict: passed ? "passed" : outOfAttempts ? "moving-on" : "retry",
    score: rounded,
    threshold,
    attempts: attempt,
    attemptsLeft: passed || outOfAttempts ? 0 : Math.max(0, maxAttempts - attempt),
    advance: passed || outOfAttempts,
    // Only the capped path is unfinished business. A pass is finished, and a
    // retry has not finished yet.
    markForReview: !passed && outOfAttempts
  };
}

/**
 * What the screen says about a verdict.
 *
 * Bilingual EN · ES, the convention the tutor screens already use ("Learning ·
 * Aprendiendo", "I want to practice · Quiero practicar"). This is the app's
 * own chrome speaking to its two owners, not the lesson — lesson content and
 * the Azure coaching line are already written in the learner's language by
 * app/api/tutor/assess/route.ts.
 *
 * The tone rule, which is the point of the whole change: none of these three
 * strings may say the learner failed. The capped one is the one that would be
 * tempted to, and it is the one Liz will read most.
 */
export function crawlFraming(verdict: CrawlVerdict): string {
  switch (verdict) {
    case "passed":
      return "Got it — next phrase · Muy bien — siguiente frase";
    case "moving-on":
      return "Close enough — we'll circle back · Suficiente por ahora — volveremos";
    case "retry":
      return "Almost — give it one more · Casi — una vez más";
  }
}
