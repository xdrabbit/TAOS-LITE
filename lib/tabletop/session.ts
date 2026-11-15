// The GA Realtime session /tabletop "live" mode runs on, as one object.
//
// Extracted from app/api/tabletop/realtime/route.ts in the cost pass of
// 2026-08-28, for the same reason as lib/live/session.ts: the measurement
// harness drives this builder against the real API, so the per-minute figures
// in docs/realtime-cost-model.md describe the session that actually ships.

import {
  buildAutoInstructions,
  buildTurnInstructions,
  type TabletopAutoPair,
  type TabletopDirection
} from "@/lib/tabletop/instructions";
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

/**
 * How sensitive server VAD is, by name. TAOS_TABLETOP_VAD picks one for the
 * whole deployment; there is no UI for it yet.
 *
 *   party   0.6 — the default, and exactly what shipped before the knob
 *           existed. A high bar so clinks and a crowd do not commit empty
 *           segments (the /live hallucination lesson).
 *   quiet   0.4 — for a quiet table and a soft voice. At 0.6 a voice that
 *           never clears the bar is never heard: server VAD does not keep
 *           audio it has not called speech, so there is nothing to flush
 *           afterwards (tests/live-fire/tabletop-flush.measure.ts).
 *
 * The pause that ends a phrase (silence_duration_ms) is the same in both:
 * the segment-end clock in lib/tabletop/metrics.ts is built on it.
 */
export type TabletopVadProfile = "party" | "quiet";

export const TABLETOP_VAD_PROFILES: Record<TabletopVadProfile, { threshold: number; silence_duration_ms: number }> = {
  party: { threshold: 0.6, silence_duration_ms: 550 },
  quiet: { threshold: 0.4, silence_duration_ms: 550 }
};

/** TAOS_TABLETOP_VAD=party|quiet. Anything else — unset, a typo — is party. */
export function tabletopVadProfile(raw: string | undefined = process.env.TAOS_TABLETOP_VAD): TabletopVadProfile {
  return raw?.trim().toLowerCase() === "quiet" ? "quiet" : "party";
}

/**
 * How much of the context cap one segment may fill before the client commits
 * it by hand (lib/tabletop/turnFlush.ts).
 *
 * The cap is not "one segment's worth": the server prunes to retention_ratio
 * (0.8) of it, and the previous response's text is in there too. Measured on
 * this session at cap 100, several unbroken segments in a row: 4 s and 6 s
 * (68 audio tokens) are read; 7 s (76) comes back with `audio_tokens: 0` and
 * an invented sentence, every time. 0.55 puts the cut at 5.5 s — about 56
 * tokens with VAD's 300 ms of padding — and leaves room for a tap that lands
 * just before the cut, which adds the pause VAD waits for.
 */
export const TABLETOP_SEGMENT_BUDGET_RATIO = 0.55;

/**
 * The longest one segment may run, in ms, for the client's segment budget.
 * Follows the cap, so raising OPENAI_TABLETOP_CONTEXT_TOKENS lengthens it by
 * itself; no cap ("off") → null, nothing to outgrow, never cut.
 * TAOS_TABLETOP_MAX_SEGMENT_MS overrides: a number of ms (≥ 2000), or "off".
 */
export function tabletopMaxSegmentMs(
  cap: number | null = TABLETOP_CONTEXT_TOKEN_LIMIT,
  raw: string | undefined = process.env.TAOS_TABLETOP_MAX_SEGMENT_MS
): number | null {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed === "off") return null;
  const parsed = Number(trimmed);
  if (trimmed && Number.isFinite(parsed) && parsed >= 2000) return Math.floor(parsed);
  if (cap === null) return null;
  // Audio is 1 token per 100 ms.
  return Math.max(2000, Math.floor(cap * 100 * TABLETOP_SEGMENT_BUDGET_RATIO));
}

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
  /**
   * Auto-detect mode: the table's two languages. Set → the session opens on
   * buildAutoInstructions instead of one turn's direction. Nothing else in the
   * session changes — same text output, VAD and cap.
   */
  auto?: TabletopAutoPair;
  /** VAD sensitivity (TAOS_TABLETOP_VAD). Default "party" — the shipped one. */
  vad?: TabletopVadProfile;
}

export function buildTabletopSession(opts: TabletopSessionOptions): Record<string, unknown> {
  const cap =
    opts.contextTokenLimit === undefined ? TABLETOP_CONTEXT_TOKEN_LIMIT : opts.contextTokenLimit;
  const vad = TABLETOP_VAD_PROFILES[opts.vad ?? "party"];

  return {
    type: "realtime",
    model: opts.model,
    instructions: opts.auto ? buildAutoInstructions(opts.auto) : buildTurnInstructions(opts.direction),
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
          // Party room by default: high threshold so clinks and crowd noise
          // don't commit empty segments (the /live hallucination lesson).
          // TAOS_TABLETOP_VAD=quiet lowers it — see TABLETOP_VAD_PROFILES.
          threshold: vad.threshold,
          prefix_padding_ms: 300,
          // Phrase-sized chunks: snappy enough to feel live, long enough to
          // carry meaning.
          silence_duration_ms: vad.silence_duration_ms,
          // Text responses can't overlap like audio, so server-created
          // responses per VAD segment are safe here (unlike /live and /call).
          create_response: true,
          interrupt_response: false
        }
      }
    }
  };
}
