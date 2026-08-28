// Which modules this phone has been through, and how far.
//
// Phase 1 keeps this in localStorage, deliberately. Server-side progress is a
// phase-2+ item (docs/tutor-curriculum-plan.md) and it needs decisions this
// phase has no business making — whether progress follows the account or the
// device, what happens to a module's history when its lesson is regenerated,
// whether a pronunciation score is progress or just a score. Guessing at those
// now would mean a migration later against real rows.
//
// So: one key, one JSON object, and the same forgiving-read rule as the pill
// row (lib/translate/pinned.ts). A phone in private mode, or one that has
// never opened the tutor, gets an empty record and works exactly the same —
// progress is a convenience here, never a gate.
//
// Progress is per (module, target, learner): "I need / I want" in Spanish and
// the same module in Hindi are different work, and marking one done must not
// tick the other.

import type { TutorPhase } from "./types";

export const TUTOR_PROGRESS_KEY = "taos.tutor.progress";

export interface ModuleProgress {
  /** ISO timestamps of the last time each phase was completed. */
  crawl?: string;
  walk?: string;
  run?: string;
  /**
   * ISO timestamp of the moment the learner pressed "Finish this module".
   *
   * Distinct from having all three phases ticked, which happens on its own:
   * Run marks itself done when the scene reaches its last beat, so a learner
   * who never presses the button still ends up with three timestamps. This
   * field is the deliberate act — "I'm done with this one" — and it is what
   * the picker badges. Reading treats three ticked phases as complete anyway
   * (isModuleComplete), because a learner who did all the work before this
   * field existed did finish the module.
   */
  completedAt?: string;
  /** Best Azure pronunciation score seen in Crawl, 0-100. */
  bestScore?: number;
  /**
   * Phrases Crawl moved past on the attempt cap rather than on a passing score
   * (lib/tutor/crawl.ts). Unfinished business, not a failure list: nothing
   * reads it yet, and phase 2 is where it becomes a review pass. Written now
   * because the moment the information exists is the moment it is free to
   * keep — reconstructing it later would mean asking the learner to miss the
   * phrase a second time.
   */
  review?: string[];
}

/**
 * A cap on the review list, per (module, target, learner).
 *
 * localStorage is a few megabytes shared with the rest of the app, and a
 * lesson has a handful of pronunciation items, so this is generous. It exists
 * so a phone that somehow loops cannot grow the record without bound.
 */
export const MAX_REVIEW_MARKS = 20;

/** Keyed by progressKey(). */
export type TutorProgress = Record<string, ModuleProgress>;

export function progressKey(moduleId: string, target: string, learner: string): string {
  return `${moduleId}:${target}:${learner}`;
}

/** Crawl → Walk → Run. `null` means the module is finished. */
export function nextPhase(progress: ModuleProgress | undefined): TutorPhase | null {
  if (!progress?.crawl) return "crawl";
  if (!progress.walk) return "walk";
  if (!progress.run) return "run";
  return null;
}

/** 0-3, for the dots on the picker. */
export function completedPhases(progress: ModuleProgress | undefined): number {
  if (!progress) return 0;
  return (progress.crawl ? 1 : 0) + (progress.walk ? 1 : 0) + (progress.run ? 1 : 0);
}

/**
 * Has this module been finished?
 *
 * Either the learner pressed the button, or they walked all three phases —
 * the second half is not a fallback so much as the honest reading: the phases
 * ARE the module, and progress written before `completedAt` existed is still
 * a finished module.
 */
export function isModuleComplete(progress: ModuleProgress | undefined): boolean {
  if (!progress) return false;
  return Boolean(progress.completedAt) || completedPhases(progress) === 3;
}

/**
 * "Finish this module" was pressed.
 *
 * Ticks Run as well as stamping the finish, because the button is reachable
 * before the scene reaches its last beat ("Mark Run done →") and a module
 * cannot be complete with a phase still open. Returns a NEW object for the
 * same reason markPhaseDone does.
 */
export function finishModule(progress: TutorProgress, key: string, at: string): TutorProgress {
  return { ...progress, [key]: { ...progress[key], run: at, completedAt: at } };
}

/**
 * The module to nudge next: the first one not yet finished.
 *
 * In curriculum order rather than "the one after the one you just did" — the
 * fourteen build on each other (docs/tutor-curriculum-plan.md), so a learner
 * who skipped ahead to Trouble should still be pointed back at the first gap.
 * `null` once every module is done; there is nothing left to point at.
 */
export function nextModuleId(
  progress: TutorProgress,
  moduleIds: readonly string[],
  target: string,
  learner: string
): string | null {
  for (const id of moduleIds) {
    if (!isModuleComplete(progress[progressKey(id, target, learner)])) return id;
  }
  return null;
}

export function parseStoredProgress(raw: string | null): TutorProgress {
  if (!raw) return {};
  try {
    const stored = JSON.parse(raw) as unknown;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const out: TutorProgress = {};
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const entry: ModuleProgress = {};
      if (typeof v.crawl === "string") entry.crawl = v.crawl;
      if (typeof v.walk === "string") entry.walk = v.walk;
      if (typeof v.run === "string") entry.run = v.run;
      if (typeof v.completedAt === "string") entry.completedAt = v.completedAt;
      if (typeof v.bestScore === "number" && Number.isFinite(v.bestScore)) {
        entry.bestScore = Math.max(0, Math.min(100, v.bestScore));
      }
      if (Array.isArray(v.review)) {
        const phrases = v.review.filter((p): p is string => typeof p === "string" && p.length > 0);
        if (phrases.length) entry.review = Array.from(new Set(phrases)).slice(-MAX_REVIEW_MARKS);
      }
      out[key] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A phase finished. Returns a NEW object — the caller holds this in React
 * state, and mutating in place would leave the picker showing yesterday's dots
 * until something else forced a render.
 */
export function markPhaseDone(
  progress: TutorProgress,
  key: string,
  phase: TutorPhase,
  at: string
): TutorProgress {
  if (phase === "partner") return progress; // free talk belongs to no module
  return { ...progress, [key]: { ...progress[key], [phase]: at } };
}

/** Best score only ever goes up: Crawl is practice, not an exam to fail. */
export function recordScore(progress: TutorProgress, key: string, score: number): TutorProgress {
  const current = progress[key]?.bestScore ?? 0;
  if (!Number.isFinite(score) || score <= current) return progress;
  return { ...progress, [key]: { ...progress[key], bestScore: Math.round(score) } };
}

/**
 * Crawl moved past this phrase on the attempt cap. Idempotent — the same
 * phrase missed twice is one entry, because this is a set of things to revisit
 * and not a tally of misses.
 */
export function markForReview(progress: TutorProgress, key: string, phrase: string): TutorProgress {
  const trimmed = phrase.trim();
  if (!trimmed) return progress;
  const current = progress[key]?.review ?? [];
  if (current.includes(trimmed)) return progress;
  const review = [...current, trimmed].slice(-MAX_REVIEW_MARKS);
  return { ...progress, [key]: { ...progress[key], review } };
}

/** Is this phrase on the revisit list? */
export function isMarkedForReview(
  progress: TutorProgress,
  key: string,
  phrase: string
): boolean {
  return (progress[key]?.review ?? []).includes(phrase.trim());
}

export function readStoredProgress(): TutorProgress {
  try {
    return parseStoredProgress(window.localStorage.getItem(TUTOR_PROGRESS_KEY));
  } catch {
    return {};
  }
}

export function writeStoredProgress(progress: TutorProgress): void {
  try {
    window.localStorage.setItem(TUTOR_PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    /* private mode — the dots just won't survive a reload */
  }
}
