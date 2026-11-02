// The walkie's one rule, as a pure function: ONE voice on the channel.
//
// While the partner holds their button, this phone's button is locked
// ("canal ocupado"). While this phone holds, the partner's is. While a turn
// is in flight on this phone the button waits too — a second hold would
// queue a second upload behind the first and the two would race to the
// partner. tests/walkie.test.ts pins the table below.

export type HoldRefusal = "not-on-air" | "partner-holding" | "sending" | "no-channel";

export interface HoldConditions {
  /** The person tapped "go on air" (audio unlocked, channel joined). */
  onAir: boolean;
  /** The channel is subscribed — presence and broadcast are live. */
  joined: boolean;
  /** The partner's presence says they are holding right now. */
  partnerHolding: boolean;
  /** This phone's last turn is still uploading / translating. */
  sending: boolean;
}

/** Why a press is refused, or null when the hold may start. */
export function holdRefusal(c: HoldConditions): HoldRefusal | null {
  if (!c.onAir) return "not-on-air";
  if (!c.joined) return "no-channel";
  if (c.partnerHolding) return "partner-holding";
  if (c.sending) return "sending";
  return null;
}

export function canHold(c: HoldConditions): boolean {
  return holdRefusal(c) === null;
}

// ── A busy lock that cannot stick ──────────────────────────────────────────
// "Holding" is presence state, and presence is a cache: if the partner's
// release never reaches this phone (their socket dropped, their app was
// suspended mid-turn, the gesture was lost), the lock would hold forever.
// So holding is a HEARTBEAT, not a flag: the recording phone re-tracks
// every HOLD_HEARTBEAT_MS with a fresh beat, and this phone treats the
// partner as released when either clock runs out:
//
//   stale    no fresh beat for HOLD_STALE_MS (two missed beats + 2 s slack)
//   ceiling  held longer than the turn cap + HOLD_GRACE_MS — the cap sends
//            the turn by itself, so a lock past it is a lie by definition
//
// Numbers (2026-11-02): beat 4 s, stale 10 s, grace 5 s → with the default
// 30 s cap the lock never outlives 35 s, and a vanished partner frees the
// channel within 10 s of their last beat.
export const HOLD_HEARTBEAT_MS = 4_000;
export const HOLD_STALE_MS = 10_000;
export const HOLD_GRACE_MS = 5_000;

export interface HoldClock {
  /** When this phone first saw the partner holding (its own clock). */
  since: number;
  /** When the last fresh beat arrived (its own clock). */
  seenAt: number;
}

export function holdingExpired(clock: HoldClock, nowMs: number, capMs: number): boolean {
  if (nowMs - clock.seenAt > HOLD_STALE_MS) return true;
  return nowMs - clock.since > capMs + HOLD_GRACE_MS;
}

// ── A sent turn that nobody picked up ──────────────────────────────────────
// "ready" is a broadcast: fire and forget, to whoever is subscribed right
// now. The sender waits this long for the partner's "got"; past it the turn
// is reported as not delivered (a banner, and fail_stage=deliver on the
// timing line) rather than sitting at "…" forever. The receiver's own
// catch-up poll runs on a shorter cadence, so a live partner normally
// answers well inside this window.
export const DELIVERY_WAIT_MS = 8_000;
/** How often an on-air phone asks the server for turns the channel missed. */
export const CATCH_UP_EVERY_MS = 5_000;
