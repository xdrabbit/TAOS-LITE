// The GA Realtime session the /call interpreter runs on, as one object.
//
// It lived inline in app/api/call/realtime/route.ts until 2026-08-31. /live and
// /tabletop were extracted into builders during the cost pass of 8/28 for a
// reason that was never tidiness — tests/live-fire/realtime-driver.ts drives
// the builder against the real API, so a measurement is a measurement OF THE
// THING THAT SHIPS. /call was left inline, and so /call became the one realtime
// surface whose session object no instrument had ever seen. The 8/31 captions
// field report was diagnosed by copying this object into a throwaway script by
// hand, which is exactly the practice lib/live/session.ts exists to end.

import { buildCallInterpreterInstructions, type CallDirection } from "@/lib/call/instructions";
import { contextTokenLimitFromEnv, truncationCap } from "@/lib/realtime/truncation";

/**
 * How much conversation the model may re-read per response, in tokens after
 * the instructions. 100 ≈ one phrase-sized VAD segment of audio.
 *
 * An interpreter translates the utterance in front of it; the twenty turns
 * behind it are context it never uses and pays $32/Mtok to re-read. Measured
 * over five turns: uncapped billed 209% of the audio actually spoken and was
 * still climbing (49→100→164→227 tokens per turn); at 100 it billed 66% and
 * held flat, with translations that were word-for-word as good.
 */
export const CALL_CONTEXT_TOKEN_LIMIT = contextTokenLimitFromEnv(
  process.env.OPENAI_CALL_CONTEXT_TOKENS,
  100
);

/**
 * The minted secret is only good for two minutes. It is spent immediately —
 * the client mints and connects in one breath — so a longer window is only
 * useful to somebody who got hold of it out of a log or a proxy.
 */
export const CALL_SECRET_TTL_SECONDS = 120;

/** How the translation reaches the listener's ear. See lib/call/interpreter.ts. */
export type CallVoiceMode = "clone" | "instant";

export interface CallSessionOptions {
  direction: CallDirection;
  model: string;
  voice: string;
  transcribeModel: string;
  mode: CallVoiceMode;
  /**
   * Override the context cap. `null` removes the `truncation` block entirely —
   * the API's expensive "auto" default. Only the measurement harness passes
   * null, to measure the "before" column.
   */
  contextTokenLimit?: number | null;
}

export function buildCallSession(opts: CallSessionOptions): Record<string, unknown> {
  const cap =
    opts.contextTokenLimit === undefined ? CALL_CONTEXT_TOKEN_LIMIT : opts.contextTokenLimit;

  return {
    type: "realtime",
    model: opts.model,
    instructions: buildCallInterpreterInstructions(opts.direction),
    // "clone" — the model writes TEXT and /api/tts speaks it in the app's own
    // voices (Liz's clone reading her own words in English, per the
    // voice-follows-speaker rule in lib/tts/voice.ts). Cheaper AND the better
    // voice; it costs about a second of extra latency because the sentence has
    // to finish before it can be synthesised.
    // "instant" — the model speaks directly. Lower latency, a stock voice, and
    // the most expensive line item on the call.
    output_modalities: opts.mode === "instant" ? ["audio"] : ["text"],
    // Full translation needs more room than ambient's 120-token summaries, but
    // still capped: an unbounded response is a stale response.
    max_output_tokens: 400,
    // THE cost guard. See CALL_CONTEXT_TOKEN_LIMIT above.
    ...(cap === null ? {} : { truncation: truncationCap(cap) }),
    audio: {
      input: {
        // The partner is on a phone held to their face, so near_field is the
        // right profile. It filters the buffer before VAD sees it, which
        // means fewer segments committed for a passing bus — and a segment
        // that is never committed is a segment never billed or transcribed.
        noise_reduction: { type: "near_field" },
        // Input transcription drives the faint "they said: …" caption line.
        transcription: { model: opts.transcribeModel },
        turn_detection: {
          type: "server_vad",
          // The input here is a clean single remote voice (not a noisy room),
          // so the default-ish threshold is fine and keeps latency down.
          threshold: 0.5,
          prefix_padding_ms: 300,
          // 500ms: phone-call turn-taking is faster than dinner chatter, and
          // chopped fragments are re-joined by the client's response gating.
          silence_duration_ms: 500,
          // The CLIENT creates responses (lib/call/interpreter.ts), same
          // proven gating as /live: waits until the previous translation has
          // finished generating AND playing, so translations never overlap.
          create_response: false,
          interrupt_response: false
        }
      },
      // Slightly fast so the interpreter keeps up with a lively speaker. Only
      // read in "instant" mode; a text session has no voice.
      ...(opts.mode === "instant" ? { output: { voice: opts.voice, speed: 1.1 } } : {})
    }
  };
}
