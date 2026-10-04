// How many new lessons one person may generate in a month.
//
// POST /api/tutor/lesson and POST /api/study/lesson both mint a completion on
// a cache miss. Before this module, nothing counted them: any signed-in free
// account could generate without limit, and Study's `force: true` skipped the
// cache on purpose, so every forced call was a fresh paid call. Tom's standing
// rule: never sell unlimited anything on a product with per-unit costs.
//
// ── The numbers, and where they came from (2026-10-04) ─────────────────────
//
// Read off production, not invented:
//   * Study shipped 10/02. In its first two days Tom made 5 lessons and Liz at
//     least 5 generations (3 saved lessons, one of them forced twice in five
//     minutes — the runtime log shows three generations of the same key).
//     That is the busiest anyone has been.
//   * Tutor's whole lesson cache, every user, since it shipped 8/25: 13
//     lessons (8 in August, 5 in September). Fourteen modules is one full
//     course in one language pair, and the cache means only the FIRST person
//     to open a module in a pair pays for it.
//
// So: Study 60 a month (a Liz-sized evening every other day, all month), and
// Tutor 30 (two full new-language courses, more than every user together has
// generated since launch). Both are several times past anything real, and both
// are env knobs so the number can move without a deploy.
//
// ── Who is counted ─────────────────────────────────────────────────────────
//
// Founders are exempt, the same rule the tutor minutes meter already follows
// (lib/tutor/meter.ts): isFounder() means no cap, but the generation is still
// RECORDED, unmetered, so a cost query sees Tom's and Liz's bill too.
//
// Cache hits never get here — the routes read the cache first and only call
// reserve on a real, paid generation.

import type { User } from "@supabase/supabase-js";
import { isFounder } from "@/lib/release";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";

export type LessonKind = "tutor" | "study";

export const LESSON_CAP_DEFAULTS: Record<LessonKind, number> = {
  tutor: 30,
  study: 60
};

const CAP_ENV: Record<LessonKind, string> = {
  tutor: "TAOS_TUTOR_LESSON_CAP",
  study: "TAOS_STUDY_LESSON_CAP"
};

export function lessonCap(kind: LessonKind): number {
  const raw = Number(process.env[CAP_ENV[kind]]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : LESSON_CAP_DEFAULTS[kind];
}

/** The machine-readable code on a refusal, so a screen can tell it apart. */
export const LESSON_CAP_CODE = "lesson_cap_reached";

const LOG = "[taos-lesson-cap]";

export type LessonReservation =
  | { ok: true; id: string | null; used: number; cap: number; unmetered: boolean }
  | { ok: false; used: number; cap: number };

/** Raised when the cap cannot be checked. The route refuses rather than pay. */
export class LessonCapUnavailableError extends Error {
  constructor(detail: string) {
    super(`Lesson cap unavailable: ${detail}`);
    this.name = "LessonCapUnavailableError";
  }
}

/**
 * Take one generation out of this month's allowance, BEFORE the provider is
 * called. A refusal costs nothing; that is the point of reserving first.
 */
export async function reserveLessonGeneration(user: Pick<User, "id" | "email">, kind: LessonKind): Promise<LessonReservation> {
  const cap = lessonCap(kind);
  const unlimited = isFounder(user.email);

  if (!hasServiceRoleKey) {
    // Same call as the tutor and /fast meters: production without the key
    // refuses; a local shell or a preview without it runs unmetered, and says so.
    if (process.env.VERCEL_ENV === "production") {
      throw new LessonCapUnavailableError("SUPABASE_SERVICE_ROLE_KEY is not set");
    }
    // eslint-disable-next-line no-console
    console.warn(`${LOG} meter_unavailable · no service-role key · unmetered`);
    return { ok: true, id: null, used: 0, cap, unmetered: true };
  }

  const { data, error } = await supabaseAdmin.rpc("lesson_generation_reserve", {
    p_user_id: user.id,
    p_kind: kind,
    p_cap: cap,
    p_unlimited: unlimited
  });
  if (error) {
    // No verdict means no reservation, and no reservation means a free lesson.
    // eslint-disable-next-line no-console
    console.error(`${LOG} reserve_failed kind=${kind} · ${error.message}`);
    throw new LessonCapUnavailableError(error.message);
  }

  const verdict = (data ?? {}) as { ok?: boolean; id?: string; used?: number; cap?: number };
  const used = Number(verdict.used ?? 0);
  if (verdict.ok !== true) {
    // eslint-disable-next-line no-console
    console.log(`${LOG} refused user=${user.id} kind=${kind} used=${used} cap=${cap}`);
    return { ok: false, used, cap };
  }
  return { ok: true, id: verdict.id ?? null, used, cap, unmetered: unlimited };
}

/**
 * Hand a reservation back when its generation never arrived (provider error,
 * timeout, an answer that failed to parse). Best effort: a failed release
 * over-counts by one, it never under-counts.
 */
export async function releaseLessonGeneration(userId: string, reservation: LessonReservation): Promise<void> {
  if (!reservation.ok || !reservation.id || !hasServiceRoleKey) return;
  try {
    await supabaseAdmin.rpc("lesson_generation_release", { p_user_id: userId, p_id: reservation.id });
  } catch {
    /* over-counts by one; never throws into the route */
  }
}

/** "November 1" — when a capped month opens again, in UTC like the count. */
export function nextResetLabel(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

const NOUN: Record<LessonKind, { made: string; still: string }> = {
  tutor: {
    made: "opened",
    still: "Lessons you've already opened still work"
  },
  study: {
    made: "made",
    still: "Your saved lessons still open"
  }
};

/** The words a person over the cap reads, shown as-is by both screens. */
export function lessonCapMessage(kind: LessonKind, cap: number, now: Date = new Date()): string {
  const n = NOUN[kind];
  return `You've ${n.made} ${cap} new lessons this month, which is the monthly limit. ${n.still} — new ones unlock ${nextResetLabel(now)}.`;
}

/** The 429 body. `error` is the only field either screen displays. */
export function lessonCapRefusal(kind: LessonKind, used: number, cap: number) {
  return {
    error: lessonCapMessage(kind, cap),
    code: LESSON_CAP_CODE,
    used,
    cap,
    resetsOn: nextResetLabel()
  };
}

/** Shown when the cap cannot be checked. 503, and nothing is spent. */
export const LESSON_CAP_UNAVAILABLE =
  "New lessons are unavailable for a moment. Please try again shortly.";
