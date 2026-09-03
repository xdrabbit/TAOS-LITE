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
// ── The one that is not obvious ────────────────────────────────────────────
// `on` and `hearing` are different states on purpose. The interpreter is fed
// the partner's audio track, FORWARDED out of the call's own peer connection
// into a second one. A forwarded track that carries silence is invisible from
// every angle the client can see — connected, open, no error, and nothing
// happens for the rest of the call. `on` means the session is up; `hearing`
// means the partner's voice has demonstrably arrived. Only the second one is
// a promise that captions are coming.

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
 * Bilingual on one line, like every other status on this screen: the two
 * people on a call read different languages and are each looking at their own
 * phone, so a status only one of them can read is a status that gets read
 * aloud over a call that is not working yet.
 */
export function interpreterCopy(
  status: InterpreterStatus,
  reason?: string | null
): InterpreterCopy {
  switch (status) {
    case "hearing":
      return {
        label: "Intérprete: ✓ activo · on",
        hint: "The interpreter is running and can hear your partner. Captions appear over the video as they speak.",
        tone: "ok"
      };
    case "on":
      return {
        label: "Intérprete: activo · on",
        hint: "The interpreter is connected. It has not heard your partner speak yet — captions start with their first sentence.",
        tone: "ok"
      };
    case "starting":
      return {
        label: "Intérprete: iniciando… · starting…",
        hint: "Connecting to the interpreter. This takes a second or two.",
        tone: "warn"
      };
    case "not_needed":
      return {
        label: "Intérprete: no hace falta · not needed",
        hint: "You and your partner are set to the same language, so there is nothing to interpret. Change either side to start it.",
        tone: "warn"
      };
    case "failed":
      return {
        label: "Intérprete: ✗ falló · failed",
        // The reason is the whole point. A bare "failed" is the state PR #52
        // spent a field test learning not to ship.
        hint: reason?.trim() || "The interpreter stopped. Tap Rejoin to try again.",
        tone: "bad"
      };
    default:
      return {
        label: "Intérprete: apagado · off",
        hint: "The interpreter is not running, so there are no captions and no translated voice.",
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
