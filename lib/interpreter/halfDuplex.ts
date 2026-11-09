// HALF-DUPLEX for a table whose speaker sits next to its microphone. Pure —
// no browser in it — so the tests run the very rule the phone runs
// (lib/interpreter/client.ts gives one of these to every leg of a session).
//
// ── Why (Tom and Liz's table, 2026-11-09, ElevenLabs, commit ef73ba5) ──────
// The interpretation plays out of the phone that is listening. The browser's
// echo canceller did not keep it out of the microphone: the two exported
// timelines show `input_audio_buffer.speech_started` on BOTH legs within
// ~60 ms of each other, again and again, with no transcript and no commit
// after it — the interpreter hearing itself. Each one was treated as a person
// barging in, and the spoken translation was cut off mid-sentence.
//
// So while ANY leg of the session is audibly playing, and for a short tail
// after it stops, the microphone of EVERY leg is sent silence instead of the
// room (both legs clone one mic — the echo of one leg's voice reaches both).
// The provider cannot hear what we do not send, so it cannot mistake our own
// voice for a speaker, cannot transcribe it, and cannot translate it back.
//
// Silence, not a gap: the stream stays continuous in time, so the provider's
// turn detection still sees a pause as a pause and closes a turn it had open.
// (ElevenLabs bills the session's clock; the silence costs nothing extra.)
//
// ── What it costs ──────────────────────────────────────────────────────────
// Someone who talks WHILE the interpretation is playing is not heard. That is
// the trade Tom asked for: "a person genuinely interrupting is rare at a
// translation table; prefer finishing the sentence."

/**
 * How long after the speaker goes quiet the microphone stays shut: the room's
 * own ring, the output path's latency past what the context reports, and the
 * 100 ms mic chunk that was being filled as the last sample played.
 */
export const HALF_DUPLEX_TAIL_MS = 300;

export interface HalfDuplex {
  /** A leg's speaker has audio scheduled until `untilMs` (wall clock). */
  playing: (leg: number, untilMs: number) => void;
  /** A leg's speaker was cut short; it is quiet from `nowMs`. */
  cut: (leg: number, nowMs: number) => void;
  /** Is any leg's voice coming out of the speaker right now? */
  speaking: (nowMs: number) => boolean;
  /** Should the microphone be sent as silence right now? (speaking, or its tail) */
  micMuted: (nowMs: number) => boolean;
}

export function createHalfDuplex(tailMs: number = HALF_DUPLEX_TAIL_MS): HalfDuplex {
  const until = new Map<number, number>();
  const latest = () => {
    let max = 0;
    for (const t of until.values()) if (t > max) max = t;
    return max;
  };
  return {
    playing: (leg, untilMs) => {
      if (!Number.isFinite(untilMs)) return;
      // Chunks of one response are scheduled back to back: the end only moves
      // later. (A cut is the one thing that moves it earlier.)
      until.set(leg, Math.max(until.get(leg) ?? 0, untilMs));
    },
    cut: (leg, nowMs) => {
      if ((until.get(leg) ?? 0) > nowMs) until.set(leg, nowMs);
    },
    speaking: (nowMs) => nowMs < latest(),
    micMuted: (nowMs) => nowMs < latest() + tailMs
  };
}

/**
 * Which engines run half-duplex. The ones whose audio WE play from PCM events
 * and whose barge-in WE therefore enforce — and, of those, the one the table
 * test showed needs it. Grok Voice shares the transport and was behaving at
 * the same table on the same commit; it is left exactly as it was until a
 * timeline says otherwise. The WebRTC engines play on a track the provider
 * paces itself, and are not ours to gate.
 */
export function engineIsHalfDuplex(engine: string): boolean {
  return engine === "elevenlabs-realtime";
}

/**
 * What a socket leg does with its SPEAKER for one provider event — shared by
 * the browser transport and the live-fire rig, so the rig measures the rule
 * the phone runs.
 *
 *   rearm   a new reply begins: shut the gate (audio is held until it has words).
 *   cut     stop what is playing and drop what is held — a barge-in.
 *
 * Full duplex: `speech_started` is the barge-in, as it always was.
 * Half-duplex: `speech_started` is nothing — at the table it was mostly our
 * own voice, and it also threw away finished replies that had not begun to
 * play. The barge-in there is the PROVIDER cancelling a reply because a new
 * turn began (`response.done`, cancelled, turn_detected): with the mic
 * silenced while we speak, what it heard to decide that was not us.
 */
export type SpeakerAction = "rearm" | "cut" | null;

export function speakerActionFor(msg: Record<string, unknown>, halfDuplex: boolean): SpeakerAction {
  const type = msg.type;
  if (type === "response.created") return "rearm";
  if (type === "input_audio_buffer.speech_started") return halfDuplex ? null : "cut";
  if (type === "response.done" && halfDuplex) {
    const response = (msg.response && typeof msg.response === "object" ? msg.response : {}) as Record<string, unknown>;
    const details = (
      response.status_details && typeof response.status_details === "object" ? response.status_details : {}
    ) as Record<string, unknown>;
    if (response.status === "cancelled" && details.reason === "turn_detected") return "cut";
  }
  return null;
}

/**
 * May the reader SHUT a leg's gate mid-reply? Not in half-duplex: the gate is
 * opened by a reply's words and shut only by the next reply beginning (rearm).
 * The provider's `output_audio_buffer.cleared` / `.stopped` used to shut it —
 * sent when it THINKS it heard speech — and every frame after that was held,
 * then thrown away when the next reply began: three finished translations in
 * one three-minute table (the `held-dropped` rows of 2026-11-09).
 */
export function gateFollows(open: boolean, halfDuplex: boolean): boolean {
  return open || !halfDuplex;
}
