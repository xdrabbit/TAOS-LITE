// When an Interpreter-mode session must end by itself. Pure arithmetic on
// timestamps so the two rules that cap a hands-free, always-listening session
// are testable without a phone or a clock:
//
//   the CAP    TAOS_INTERPRETER_MAX_MIN (30): a hard ceiling on one session.
//   the IDLE   ~60 s in which nobody spoke and the interpreter said nothing:
//              the phone was left on the table.
//
// The server stamps both numbers into the mint response; the shell ticks once
// a second and asks sessionVerdict(). "Activity" is anything the providers
// report as speech — a speech-started event, a transcript fragment, the
// interpreter's own words — never the wall clock and never mic level, which a
// noisy restaurant would keep alive forever.

export type SessionVerdict = "run" | "cap" | "idle";

/**
 * The cap never cuts a sentence in half: if someone is mid-thought when it
 * lands, the session gets up to this much longer to reach a pause.
 */
export const CAP_GRACE_MS = 20_000;
/** "A pause", for the cap's purposes. */
export const CAP_QUIET_MS = 3_000;
/** The cap warns this long before it lands. */
export const CAP_WARN_SECONDS = 60;

export interface SessionClock {
  startedAtMs: number;
  lastActivityMs: number;
  maxSeconds: number;
  idleSeconds: number;
}

export function sessionVerdict(clock: SessionClock, nowMs: number): SessionVerdict {
  const elapsed = nowMs - clock.startedAtMs;
  const quiet = nowMs - Math.max(clock.lastActivityMs, clock.startedAtMs);
  const capMs = clock.maxSeconds * 1000;
  if (elapsed >= capMs) {
    if (quiet >= CAP_QUIET_MS || elapsed >= capMs + CAP_GRACE_MS) return "cap";
    return "run";
  }
  if (quiet >= clock.idleSeconds * 1000) return "idle";
  return "run";
}

/** Whole seconds until the cap; never negative. */
export function secondsUntilCap(clock: SessionClock, nowMs: number): number {
  return Math.max(0, Math.ceil((clock.startedAtMs + clock.maxSeconds * 1000 - nowMs) / 1000));
}

export function capWarning(clock: SessionClock, nowMs: number): boolean {
  const left = secondsUntilCap(clock, nowMs);
  return left > 0 && left <= CAP_WARN_SECONDS;
}

/** "12:05" */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
