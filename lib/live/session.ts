// The GA Realtime session /live "Ambient AI" runs on, as one object.
//
// It lived inline in app/api/live/realtime/route.ts until the cost pass of
// 2026-08-28. It is a builder now for a reason that is not tidiness: the
// measurement harness (tests/live-fire/realtime-cost.measure.ts) drives THIS
// function against the real API, so the numbers in docs/realtime-cost-model.md
// describe the session the route actually mints. The /call model was measured
// against a hand-copied session object, and a hand-copied object is one edit
// away from documenting a configuration nobody ships.

import { buildAutoVerbatimInstructions, buildLiveInstructions } from "@/lib/live/instructions";
import { DEFAULT_LIVE_STYLE, type LiveStyle } from "@/lib/live/style";
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
 * The same cap for WORD-FOR-WORD style, and it is a different number for the
 * reason every surface's number is different: what the client asks for.
 *
 * Word-for-word does not ask the model to re-read the conversation at all.
 * Each response is pointed at ONE heard segment with an `item_reference`
 * (lib/live/respond.ts), and it is billed for that segment and nothing else —
 * measured 2026-11-15, per-response input audio 38 → 22 → 66 → 116 → 77 → 38
 * → 40 → 58 → 71 tokens, each one the length of its own remark, flat, with
 * the conversation growing underneath it the whole time. So the re-read this
 * cap exists to stop is already not happening, and the cap's job here is the
 * opposite one: to NOT throw away audio that has not been rendered yet.
 *
 * That is a real failure and not a theoretical one. Truncation prunes oldest
 * first, this style runs behind by design, and at a deliberately tiny cap (50)
 * a queued segment was pruned before its turn came: the response got no audio
 * (`in_audio: 0`) and the model invented a sentence. At 150 — summary's number
 * — fifteen seconds of backlog would do the same.
 *
 * 8,000, with the client refusing to render anything older than 90 seconds
 * (LIVE_VERBATIM_MAX_LAG_MS). The room adds at most 10 tokens a second and the
 * model's voice 20, so a segment that has waited 90 seconds has at most ~3,000
 * tokens stacked after it; the server prunes to 80% of the cap, 6,400, which
 * leaves that segment in with more than 2x to spare. It is still a ceiling: if
 * a client ever did send a bare `response.create` in this style, the most it
 * could re-read is 8,000 tokens (about 26¢), not an entire dinner.
 *
 *     OPENAI_LIVE_VERBATIM_CONTEXT_TOKENS=8000      ("off" = uncapped; do not)
 */
export const LIVE_VERBATIM_CONTEXT_TOKEN_LIMIT = contextTokenLimitFromEnv(
  process.env.OPENAI_LIVE_VERBATIM_CONTEXT_TOKENS,
  8000
);

/**
 * One response's ceiling, per style.
 *
 * 120 has clipped every micro-summary since /live shipped — "a long response
 * is a stale response". Applied to a word-for-word rendering it is six seconds
 * of speech (audio out is 20 tokens a second) and then a sentence cut off in
 * the middle. 1,200 is a full minute of continuous rendering in ONE response:
 * past any single stretch of talk VAD will hand over, and still a hard stop
 * on a runaway.
 */
export const LIVE_SUMMARY_MAX_OUTPUT_TOKENS = 120;
export const LIVE_VERBATIM_MAX_OUTPUT_TOKENS = 1200;

/**
 * One Auto response's ceiling. Auto WRITES (see buildLiveAutoPatch), and text
 * is about four times denser than the model's voice: the minute of continuous
 * speech that LIVE_VERBATIM_MAX_OUTPUT_TOKENS buys in audio is ~150 words,
 * well under 400 text tokens in any language of the catalog, tag included.
 * Still a hard stop on a runaway.
 */
export const LIVE_AUTO_MAX_OUTPUT_TOKENS = 400;

/** The context cap a style runs under. `null` = uncapped (env said "off"). */
export function liveContextTokenLimit(style: LiveStyle): number | null {
  return style === "verbatim" ? LIVE_VERBATIM_CONTEXT_TOKEN_LIMIT : LIVE_CONTEXT_TOKEN_LIMIT;
}

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
   * Summary (the default — what /live has always done) or word-for-word.
   * Moves exactly three fields: the instructions, the per-response ceiling
   * and the context cap. See buildLiveStylePatch.
   */
  style?: LiveStyle;
  /**
   * Override the context cap. `null` means no `truncation` block at all — the
   * API's "auto" default, which is the expensive setting. Only the measurement
   * harness passes null; it is how the "before" column gets measured.
   */
  contextTokenLimit?: number | null;
  /**
   * Two-way Auto (lib/live/auto.ts): `target` and `source` are then simply the
   * pair, either may be spoken, and the session is minted on
   * buildLiveAutoPatch — word-for-word, text out, tagged. `style` is ignored.
   */
  auto?: boolean;
}

/**
 * What an Auto session runs on: the tagged two-way prompt, TEXT output, and
 * word-for-word's context cap — unchanged, because Auto asks the way
 * word-for-word does (one `item_reference` per response) and needs the cap for
 * the same reason: not to lose a segment that is still waiting its turn.
 *
 * Text, not audio, because the tag must be the first thing produced and a
 * speaking model would say "[es]" out loud. It is also most of why Auto is the
 * cheapest minute on this screen: audio out is $64/Mtok at 20 tokens a second,
 * and this session produces none.
 */
export function buildLiveAutoPatch(opts: {
  pair: readonly [string, string];
  contextTokenLimit?: number | null;
}): Record<string, unknown> {
  const cap =
    opts.contextTokenLimit === undefined ? liveContextTokenLimit("verbatim") : opts.contextTokenLimit;
  return {
    type: "realtime",
    instructions: buildAutoVerbatimInstructions(opts.pair[0], opts.pair[1]),
    output_modalities: ["text"],
    max_output_tokens: LIVE_AUTO_MAX_OUTPUT_TOKENS,
    ...(cap === null ? {} : { truncation: truncationCap(cap) })
  };
}

/**
 * The part of the session that changes with the style — and nothing else.
 *
 * It is its own function because it is used twice. buildLiveSession spreads
 * it into the session it mints, and the mint route hands the browser one of
 * these per style, so flipping the toggle mid-dinner is a `session.update`
 * with this object rather than a hang-up and a redial (lib/live/ambient.ts,
 * setStyle). Built on the server either way: the caps follow the server's env
 * and the browser never assembles a prompt or a spend limit of its own.
 *
 * Every style states all three fields, so a patch always fully replaces the
 * other style's and switching back restores exactly what was minted.
 */
export function buildLiveStylePatch(opts: {
  style: LiveStyle;
  target: string;
  source: string;
  contextTokenLimit?: number | null;
}): Record<string, unknown> {
  const cap =
    opts.contextTokenLimit === undefined ? liveContextTokenLimit(opts.style) : opts.contextTokenLimit;
  return {
    type: "realtime",
    instructions: buildLiveInstructions(opts.style, opts.target, opts.source),
    // Keep every summary clipped even if the prompt is ignored — a long
    // response is a stale response. Word-for-word gets a minute instead.
    max_output_tokens:
      opts.style === "verbatim" ? LIVE_VERBATIM_MAX_OUTPUT_TOKENS : LIVE_SUMMARY_MAX_OUTPUT_TOKENS,
    // THE cost guard. See LIVE_CONTEXT_TOKEN_LIMIT above, and
    // lib/realtime/truncation.ts for what it stops.
    ...(cap === null ? {} : { truncation: truncationCap(cap) })
  };
}

export function buildLiveSession(opts: LiveSessionOptions): Record<string, unknown> {
  const style = opts.style ?? DEFAULT_LIVE_STYLE;

  return {
    output_modalities: ["audio"],
    // Auto's patch comes second so its `output_modalities: ["text"]` is the
    // one that stands.
    ...(opts.auto
      ? buildLiveAutoPatch({
          pair: [opts.target, opts.source],
          contextTokenLimit: opts.contextTokenLimit
        })
      : buildLiveStylePatch({
          style,
          target: opts.target,
          source: opts.source,
          contextTokenLimit: opts.contextTokenLimit
        })),
    model: opts.model,
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
