// What the interpreter is doing, in words both people on the call can read.
//
// ── Why this file exists ───────────────────────────────────────────────────
// The 2026-08-31 field report was "everything was good except NO captions",
// and answering it took the production logs, a live-fire probe against the
// real Realtime API, and a browser measuring its own layout. None of that was
// available to the two people holding the phones, because the /call screen
// said NOTHING about the interpreter — not that it was starting, not that it
// had connected, not that it had failed, not that it was connected and being
// fed silence. A session could mint, connect, translate, spend money and hang
// up without one word about it ever reaching the screen.
//
// This is the same vocabulary lib/call/relay.ts gives the relay preflight, and
// it exists for the same reason: a status only an engineer can obtain is a
// status the founders cannot use in a kitchen.
//
// ── Where the words live ───────────────────────────────────────────────────
// Not here. The labels and hints are keys in lib/chrome/copy.ts, like every
// other word on every other screen; this file owns the STATE MACHINE — which
// status maps to which key, and what colour it is. That split is what let the
// whole screen follow the phone's own language instead of shipping a Spanish
// half bolted onto an English line.
//
// ── The one that is not obvious ────────────────────────────────────────────
// `on` and `hearing` are different states on purpose. The interpreter is fed
// the partner's audio track, FORWARDED out of the call's own peer connection
// into a second one. A forwarded track that carries silence is invisible from
// every angle the client can see — connected, open, no error, and nothing
// happens for the rest of the call. `on` means the session is up; `hearing`
// means the partner's voice has demonstrably arrived. Only the second one is
// a promise that captions are coming.

import type { ChromeCopy } from "@/lib/chrome/copy";

export type InterpreterStatus =
  | "off"
  | "starting"
  | "on"
  | "hearing"
  | "not_needed"
  | "failed";

/** Tone for the indicator. `ok` is green, `warn` amber, `bad` red. */
export type InterpreterTone = "ok" | "warn" | "bad";

export interface InterpreterCopy {
  label: string;
  hint: string;
  tone: InterpreterTone;
}

/**
 * The line the call screen shows, and the meaning under it.
 *
 * `copy` is the chrome table for the language THIS phone's owner reads
 * (lib/chrome/copy.ts). These lines used to be bilingual and Spanish-first —
 * "Intérprete: activo · on" — because that was the only way a mixed pair
 * could both read one screen. On a call there are two screens, one per
 * person, so each one now speaks its owner's language and the doubling is
 * gone. A language with no entry falls back to English, key by key.
 */
export function interpreterCopy(
  status: InterpreterStatus,
  reason: string | null | undefined,
  copy: ChromeCopy
): InterpreterCopy {
  switch (status) {
    case "hearing":
      return {
        label: copy.interpreterHearingLabel,
        hint: copy.interpreterHearingHint,
        tone: "ok"
      };
    case "on":
      return {
        label: copy.interpreterOnLabel,
        hint: copy.interpreterOnHint,
        tone: "ok"
      };
    case "starting":
      return {
        label: copy.interpreterStartingLabel,
        hint: copy.interpreterStartingHint,
        tone: "warn"
      };
    case "not_needed":
      return {
        label: copy.interpreterNotNeededLabel,
        hint: copy.interpreterNotNeededHint,
        tone: "warn"
      };
    case "failed":
      return {
        label: copy.interpreterFailedLabel,
        // The reason is the whole point. A bare "failed" is the state PR #52
        // spent a field test learning not to ship. It arrives from the
        // provider in English and stays that way — a translated guess at
        // somebody else's error message is worse than the message.
        hint: reason?.trim() || copy.interpreterFailedHint,
        tone: "bad"
      };
    default:
      return {
        label: copy.interpreterOffLabel,
        hint: copy.interpreterOffHint,
        tone: "warn"
      };
  }
}

/**
 * Does this status mean captions can be expected?
 *
 * Used by the screen to decide whether an empty caption panel should say
 * "waiting for them to speak" or say what is actually wrong. An empty panel
 * that reads "Captions appear here…" while the session is dead is the exact
 * shape of the 8/31 report.
 */
export function captionsExpected(status: InterpreterStatus): boolean {
  return status === "on" || status === "hearing";
}
