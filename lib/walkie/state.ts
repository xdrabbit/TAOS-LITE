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
