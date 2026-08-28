// The GA Realtime session /live "Ambient AI" runs on, as one object.
//
// It lived inline in app/api/live/realtime/route.ts until the cost pass of
// 2026-08-28. It is a builder now for a reason that is not tidiness: the
// measurement harness (tests/live-fire/realtime-cost.measure.ts) drives THIS
// function against the real API, so the numbers in docs/realtime-cost-model.md
// describe the session the route actually mints. The /call model was measured
// against a hand-copied session object, and a hand-copied object is one edit
// away from documenting a configuration nobody ships.

import { buildInterpreterInstructions } from "@/lib/live/instructions";
import { contextTokenLimitFromEnv, truncationCap } from "@/lib/realtime/truncation";

/**
 * How much conversation Ambient AI may re-read per response, in tokens after
 * the instructions.
 *
 * 150, and the number comes from the prompt rather than from the bill. The
 * interpreter is told, in lib/live/instructions.ts: *"If you have fallen
 * behind, do NOT try to catch up — old content is worthless. Summarize only
 * the most recent 10-15 seconds and skip the rest."* Audio bills at 1 token
 * per 100 ms, so ten to fifteen seconds IS 100-150 tokens. Anything the cap
 * lets through above that is history the prompt has already forbidden the
 * model to use, bought at $32/Mtok.
 *
 * It is higher than /call's 100 on purpose. /call translates one utterance and
 * moves on; /live COALESCES — everything said while the last summary was
 * playing gets folded into the next one (see `pendingTurns` in
 * lib/live/ambient.ts), so a busy dinner table can have three or four
 * committed segments waiting when a response fires. Capping at one segment
 * would silently drop the older half of a summary the UI promised was a
 * summary of everything.
 */
export const LIVE_CONTEXT_TOKEN_LIMIT = contextTokenLimitFromEnv(
  process.env.OPENAI_LIVE_CONTEXT_TOKENS,
  150
);

/**
 * A minted secret is good for two minutes. The client mints and connects in
 * one breath, so a longer window is only useful to somebody who lifted the
 * secret out of a log or a proxy. Matches /call.
 */
export const LIVE_SECRET_TTL_SECONDS = 120;

export interface LiveSessionOptions {
  /** What the listener reads and hears — their own language. */
  target: string;
  /** What is being spoken around them, so the prompt can name it. */
  source: string;
  model: string;
  voice: string;
  transcribeModel: string;
  /**
   * Override the context cap. `null` means no `truncation` block at all — the
   * API's "auto" default, which is the expensive setting. Only the measurement
   * harness passes null; it is how the "before" column gets measured.
   */
  contextTokenLimit?: number | null;
}

export function buildLiveSession(opts: LiveSessionOptions): Record<string, unknown> {
  const cap = opts.contextTokenLimit === undefined ? LIVE_CONTEXT_TOKEN_LIMIT : opts.contextTokenLimit;

  return {
    type: "realtime",
    model: opts.model,
    instructions: buildInterpreterInstructions(opts.target, opts.source),
    output_modalities: ["audio"],
    // Keep every summary clipped even if the prompt is ignored — a long
    // response is a stale response.
    max_output_tokens: 120,
    // THE cost guard. See LIVE_CONTEXT_TOKEN_LIMIT above, and
    // lib/realtime/truncation.ts for what it stops.
    ...(cap === null ? {} : { truncation: truncationCap(cap) }),
    audio: {
      input: {
        // NO noise_reduction here, unlike /call and /tabletop. Both of those
        // listen to one near-field voice; ambient mode's whole job is the far
        // side of the room — the dinner table, the television, the person two
        // seats down. near_field would filter away the audio the feature
        // exists to hear. The VAD threshold below is what keeps clinks out.
        //
        // Input transcription lets the UI show a faint "heard: …" line so the
        // user can sanity-check what the mic actually picked up.
        transcription: { model: opts.transcribeModel },
        turn_detection: {
          type: "server_vad",
          // 0.6: fewer false triggers from clinks/coughs/room noise — those
          // committed empty turns and fed the hallucination problem.
          threshold: 0.6,
          prefix_padding_ms: 300,
          // 600ms: 450 chopped speech into fragments and the summaries came
          // out disjointed. Still snappier than the tutor's 700ms.
          silence_duration_ms: 600,
          // The CLIENT creates responses (lib/live/ambient.ts): auto-created
          // responses fired at every VAD pause and their audio overlapped when
          // people talked fast. The client waits until the previous summary
          // finishes playing, coalescing everything said meanwhile into one
          // fresh summary — freshness by design.
          create_response: false,
          // Never cancel a summary mid-word because someone kept talking
          // (which is always, at a dinner).
          interrupt_response: false
        }
      },
      // Slightly fast delivery keeps the earpiece current.
      output: { voice: opts.voice, speed: 1.15 }
    }
  };
}
