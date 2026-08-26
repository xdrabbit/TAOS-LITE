// The handful of words the tutor's server, client and prompts all have to
// agree on. Small file on purpose: lib/tutor/conversation.ts is "use client"
// and app/api/tutor/* is Node, so neither can import the other's types
// without dragging the wrong runtime along. They both import this.

/** How much scaffolding the tutor gives. Unchanged from the RC1 tutor. */
export type TutorLevel = "beginner" | "intermediate" | "advanced";

/**
 * Where in the lesson loop a session is (docs/tutor-curriculum-plan.md):
 *
 *   crawl   — hear it, contrast note, repeat, Azure scores it. No realtime
 *             session at all; this phase is TTS + the assess route.
 *   walk    — scripted roleplay from the module's seed. The tutor plays the
 *             counterpart and the learner has lines to hit.
 *   run     — free conversation, tutor in character, gently kept in-module.
 *   partner — Conversation Partner: no curriculum, no module, level-matched
 *             free talk. The Taiwan use case, pure.
 */
export type TutorPhase = "crawl" | "walk" | "run" | "partner";

export function toTutorLevel(value: unknown): TutorLevel {
  return value === "beginner" ? "beginner" : value === "advanced" ? "advanced" : "intermediate";
}

export function toTutorPhase(value: unknown): TutorPhase {
  return value === "walk" || value === "run" || value === "crawl" || value === "partner"
    ? value
    : "partner";
}
