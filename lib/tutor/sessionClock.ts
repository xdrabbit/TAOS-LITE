// When a metered tutor session warns, and when it ends.
//
// Two rules, and both of them are about the fact that the thing being
// interrupted is a CONVERSATION:
//
//   1. WARN AT T-2 MINUTES. Not at zero. A learner mid-sentence in a language
//      they are bad at deserves to know the room is about to close, in time to
//      finish a thought and say goodbye. Two minutes is enough for that and
//      short enough not to become the session.
//
//   2. END AT A TURN BOUNDARY. The cap arriving while the tutor is speaking
//      does not cut it off. `requestEnd` sets a flag; the session stops on the
//      next `turnEnded`. A hard backstop exists because a turn that never
//      finishes — a stalled response, a dropped data channel — would otherwise
//      hold the microphone and the meter open forever, and the whole point of
//      a cap is that something can be relied on to close it.
//
// Kept pure and out of lib/tutor/conversation.ts on purpose: the WebRTC path
// needs a browser, a microphone and a paid OpenAI session to run at all, and
// "does the warning fire before the end" is arithmetic. tests/tutor-metering
// drives the whole warn-then-end sequence through these functions.

/** Seconds before the end that the learner is warned. Mirrors TUTOR_WARN_SECONDS. */
export const WARN_LEAD_SECONDS = 120;

/**
 * How long a turn is allowed to run past the cap before it is cut anyway.
 *
 * A generous turn is ~20s of speech. Thirty gives a long answer room to land
 * and still bounds the overrun — and because the grant is what was reserved,
 * the overrun is spent from the reservation rather than added to it: the
 * ledger bills at most the grant either way (lib/tutor/meter.ts).
 */
export const TURN_GRACE_SECONDS = 30;

export interface SessionClock {
  /** Total seconds this session was granted. */
  grantedSeconds: number;
  /** Elapsed seconds at which to warn, or null when the session is too short. */
  warnAtSeconds: number | null;
  /** Elapsed seconds at which to ask for a graceful end. */
  endAtSeconds: number;
  /** Elapsed seconds at which to stop regardless of whose turn it is. */
  hardStopAtSeconds: number;
}

/**
 * Plan a session's clock from what the meter granted.
 *
 * A grant shorter than the warning lead gets NO warning: telling someone with
 * ninety seconds left that they have two minutes left is worse than saying
 * nothing, and the chip in the header already showed them the number.
 */
export function planSessionClock(
  grantedSeconds: number,
  warnLead = WARN_LEAD_SECONDS,
  grace = TURN_GRACE_SECONDS
): SessionClock {
  const granted = Math.max(0, Math.round(grantedSeconds));
  const warnAt = granted - warnLead;
  return {
    grantedSeconds: granted,
    warnAtSeconds: warnAt > 0 ? warnAt : null,
    endAtSeconds: granted,
    hardStopAtSeconds: granted + Math.max(0, grace)
  };
}

/** What the tick at `nowSeconds` should do, given it last ran at `prevSeconds`. */
export type ClockEvent = "warn" | "end" | "hard-stop";

/**
 * Which thresholds were crossed between two ticks.
 *
 * Crossing rather than equality, because a tick can be late — a backgrounded
 * tab on iOS fires its interval whenever the OS feels like it, and a warning
 * that only fires on the exact second is a warning that does not fire.
 */
export function clockEventsBetween(
  prevSeconds: number,
  nowSeconds: number,
  clock: SessionClock
): ClockEvent[] {
  const crossed = (threshold: number | null): boolean =>
    threshold !== null && prevSeconds < threshold && nowSeconds >= threshold;
  const events: ClockEvent[] = [];
  if (crossed(clock.warnAtSeconds)) events.push("warn");
  if (crossed(clock.endAtSeconds)) events.push("end");
  if (crossed(clock.hardStopAtSeconds)) events.push("hard-stop");
  return events;
}

// ── The turn gate ───────────────────────────────────────────────────────────

export interface TurnGate {
  /** True while the tutor is producing a turn. */
  speaking: boolean;
  /** Set once the cap is reached and we are waiting for the turn to land. */
  pending: boolean;
}

export function newTurnGate(): TurnGate {
  return { speaking: false, pending: false };
}

/** The tutor started a turn. */
export function turnStarted(gate: TurnGate): TurnGate {
  return { ...gate, speaking: true };
}

/**
 * The cap was reached.
 *
 * Mid-turn: hold. Between turns: stop now — there is nothing to wait for, and
 * waiting would leave a paid session open until the learner happened to speak.
 */
export function requestEnd(gate: TurnGate): { gate: TurnGate; stopNow: boolean } {
  if (!gate.speaking) return { gate: { ...gate, pending: true }, stopNow: true };
  return { gate: { ...gate, pending: true }, stopNow: false };
}

/** The tutor finished a turn. Stops if the cap arrived while it was talking. */
export function turnEnded(gate: TurnGate): { gate: TurnGate; stopNow: boolean } {
  return { gate: { ...gate, speaking: false }, stopNow: gate.pending };
}
