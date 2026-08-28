// The GA Realtime session /tabletop "live" mode runs on, as one object.
//
// Extracted from app/api/tabletop/realtime/route.ts in the cost pass of
// 2026-08-28, for the same reason as lib/live/session.ts: the measurement
// harness drives this builder against the real API, so the per-minute figures
// in docs/realtime-cost-model.md describe the session that actually ships.

import { buildTurnInstructions, type TabletopDirection } from "@/lib/tabletop/instructions";
import { contextTokenLimitFromEnv, truncationCap } from "@/lib/realtime/truncation";

/**
 * How much conversation a table turn may re-read per response, in tokens after
 * the instructions.
 *
 * 100 — the tightest of the three surfaces, and the prompt is again the reason.
 * lib/tabletop/instructions.ts says *"Translate each phrase on its own; do not
 * recap earlier phrases"*, and the session is minted with
 * `create_response: true`, so one response covers exactly one VAD segment of
 * one person's turn. There is no coalescing to protect (that is /live's
 * problem) and no thread of conversation to keep (that is a tutor's). 100
 * tokens is ten seconds of audio, comfortably more than the phrase in front of
 * it.
 *
 * The table is also the surface where an uncapped session hurts most. It is
 * ONE session that outlives every turn — it is minted once and re-pointed with
 * `session.update` as the phone goes round the table — so "the conversation so
 * far" is not one person's turn, it is the whole party, and every phrase after
 * the first re-reads all of it.
 */
export const TABLETOP_CONTEXT_TOKEN_LIMIT = contextTokenLimitFromEnv(
  process.env.OPENAI_TABLETOP_CONTEXT_TOKENS,
  100
);

/** Two minutes, same reasoning as /call and /live. */
export const TABLETOP_SECRET_TTL_SECONDS = 120;

export interface TabletopSessionOptions {
  direction: TabletopDirection;
  model: string;
  transcribeModel: string;
  /**
   * Override the context cap. `null` removes the `truncation` block entirely —
   * the API's expensive "auto" default. Only the measurement harness passes
   * null, to measure the "before" column.
   */
  contextTokenLimit?: number | null;
}

export function buildTabletopSession(opts: TabletopSessionOptions): Record<string, unknown> {
  const cap =
    opts.contextTokenLimit === undefined ? TABLETOP_CONTEXT_TOKEN_LIMIT : opts.contextTokenLimit;

  return {
    type: "realtime",
    model: opts.model,
    instructions: buildTurnInstructions(opts.direction),
    // TEXT ONLY: the streamed translation is read off the pane; audio readout
    // happens at turn end via /api/tts (cloned voices, party-volume mp3).
    output_modalities: ["text"],
    // One VAD segment's translation — segments are phrase-sized.
    max_output_tokens: 300,
    // THE cost guard. See TABLETOP_CONTEXT_TOKEN_LIMIT above.
    ...(cap === null ? {} : { truncation: truncationCap(cap) }),
    audio: {
      input: {
        // The speaker is leaning over a phone on the table and the enemy is
        // the party around them — the same near-field case /call has, and the
        // opposite of /live's. A segment VAD never commits is a segment never
        // billed and never transcribed.
        noise_reduction: { type: "near_field" },
        // The speaker's own pane shows the running "heard" transcript.
        transcription: { model: opts.transcribeModel },
        turn_detection: {
          type: "server_vad",
          // Party room: high threshold so clinks and crowd noise don't commit
          // empty segments (the /live hallucination lesson).
          threshold: 0.6,
          prefix_padding_ms: 300,
          // Phrase-sized chunks: snappy enough to feel live, long enough to
          // carry meaning.
          silence_duration_ms: 550,
          // Text responses can't overlap like audio, so server-created
          // responses per VAD segment are safe here (unlike /live and /call).
          create_response: true,
          interrupt_response: false
        }
      }
    }
  };
}
