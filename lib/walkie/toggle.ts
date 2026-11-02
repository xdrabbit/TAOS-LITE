// The button, as a pure state machine. Tap to talk, tap to send.
//
// Tom's decision after the first two-phone test (2026-11-01, iPhone 17 +
// Galaxy S23): tap-to-toggle on BOTH platforms. One tap starts the turn
// (key-down chirp), the second tap stops it and sends; the cap still sends
// by itself. No long press anywhere — which also takes the iOS long-press
// cue, the lead suspect in the open tap-eating bug, out of Taokie.
//
// Why a machine and not two booleans: the hold button's bug was a race
// between the finger and the microphone. getUserMedia takes 200-800 ms on a
// phone (the mic is re-opened every turn), and the PR #114 handlers ignored
// a release that arrived before the recorder existed — so a tap shorter
// than the warm-up started a recording after the finger was gone and nothing
// ever stopped it. Then lostpointercapture, firing after every pointerup,
// stopped the turn a SECOND time and stamped it cancelled. Both are
// impossible here: "arming" is a state, and "stopping" swallows every
// event until the recorder has actually stopped. tests/walkie.test.ts pins
// the table.

export type ToggleState = "idle" | "arming" | "recording" | "stopping";

export type ToggleEvent =
  /** The button went down (pointerdown — never click, never up). */
  | "tap"
  /** The microphone opened and the recorder is running. */
  | "armed"
  /** The microphone was refused or is missing. */
  | "arm_failed"
  /** The turn cap was reached: the turn sends itself. */
  | "cap"
  /** pointercancel, the mic track ending, a recorder error: send what we have. */
  | "cancel"
  /** The recorder's onstop fired; the blob is being sent. */
  | "stopped";

export type ToggleEffect = "start" | "stop" | "stop_cancelled" | null;

export interface ToggleStep {
  state: ToggleState;
  effect: ToggleEffect;
}

export function toggleStep(state: ToggleState, event: ToggleEvent): ToggleStep {
  switch (state) {
    case "idle":
      if (event === "tap") return { state: "arming", effect: "start" };
      return { state, effect: null };
    case "arming":
      if (event === "armed") return { state: "recording", effect: null };
      if (event === "arm_failed") return { state: "idle", effect: null };
      // A second tap, a cancel or a cap while the mic is still opening changes
      // nothing: the turn the first tap started will run, and the next tap
      // on a RECORDING button ends it. (The PR #114 race, closed.)
      return { state, effect: null };
    case "recording":
      if (event === "tap" || event === "cap") return { state: "stopping", effect: "stop" };
      if (event === "cancel") return { state: "stopping", effect: "stop_cancelled" };
      if (event === "stopped") return { state: "idle", effect: null };
      return { state, effect: null };
    case "stopping":
      if (event === "stopped") return { state: "idle", effect: null };
      // Everything else is ignored: a stop is stopped once, and a late
      // cancel cannot re-stamp a sent turn as cancelled.
      return { state, effect: null };
  }
}

/** The label the button wears in each state (keys into lib/chrome/copy.ts). */
export function toggleLabelKey(state: ToggleState): "walkieHold" | "walkieStarting" | "walkieHolding" | "walkieSending" {
  if (state === "arming") return "walkieStarting";
  if (state === "recording") return "walkieHolding";
  if (state === "stopping") return "walkieSending";
  return "walkieHold";
}
