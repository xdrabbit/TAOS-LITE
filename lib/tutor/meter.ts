// The seam phase 2 bolts metering onto.
//
// Phase 1 does NOT meter plan minutes — that is step 5 of
// docs/tutor-curriculum-plan.md and the thing that has to land before a
// customer can reach the tutor at all. What phase 1 owes phase 2 is a shape:
// one place that knows a tutor session started, one place that knows it
// ended, and a duration in between that came from the SERVER's clock rather
// than from a number the browser chose to report.
//
// Today both places do exactly one thing — write a structured line to the
// Vercel runtime log (project `taos-lite`), which is how every production
// question about this app has actually been answered. `taos.tutor.session` is
// the grep handle:
//
//   vercel logs --json | grep taos.tutor.session
//
// What phase 2 adds, in these same two functions and nowhere else:
//   start — refuse when the month's plan minutes are already spent (the
//           allowance check that lives in app/api/tutor/realtime today moves
//           behind this, so Walk, Run and Partner cannot each grow their own
//           copy of it), and reserve against the balance.
//   end   — debit the balance by the elapsed seconds and write the row that
//           lib/supabase.ts's getMonthlyUsage() reads.
//
// Deliberately NOT a database write yet. tutor_sessions is written from the
// browser today (lib/supabase.ts startTutorSession/endTutorSession, under
// RLS), and moving that server-side is a metering decision with a migration
// attached — phase 2's call to make, not a thing to half-do here.

export type TutorSessionEndReason = "user" | "cap" | "idle" | "error" | "unknown";

export interface TutorSessionStartEvent {
  event: "start";
  sessionId: string;
  /** Supabase user id, or null on a path that allowed an anonymous caller. */
  userId: string | null;
  phase: string;
  moduleId?: string | null;
  target: string;
  learner: string;
  level: string;
  /** The realtime model actually minted — the line item on the OpenAI bill. */
  model?: string;
  /** The hard cap this session was minted under, in seconds. */
  capSeconds?: number;
}

export interface TutorSessionEndEvent {
  event: "end";
  sessionId: string;
  userId: string | null;
  /** Elapsed seconds. Phase 2 debits plan minutes with this number. */
  seconds: number;
  reason: TutorSessionEndReason;
  phase?: string;
  moduleId?: string | null;
}

export type TutorSessionEvent = TutorSessionStartEvent | TutorSessionEndEvent;

/** The one log prefix. Change it here and every dashboard query follows. */
export const TUTOR_SESSION_LOG = "taos.tutor.session";

/**
 * Emit a session event.
 *
 * Never throws: a metering line is not worth failing a lesson over, and the
 * fact that it cannot fail is precisely why phase 2 must not put the actual
 * debit in a `catch {}` next to it.
 */
export function logTutorSessionEvent(event: TutorSessionEvent): void {
  try {
    // eslint-disable-next-line no-console
    console.log(`${TUTOR_SESSION_LOG} ${JSON.stringify(event)}`);
  } catch {
    /* ignore */
  }
}

/** An id that ties a start line to its end line in the log. */
export function newTutorSessionId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `ts_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}
