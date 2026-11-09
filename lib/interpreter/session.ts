// The provider session objects Interpreter mode runs on, as pure builders —
// the same split as lib/tabletop/session.ts and lib/live/session.ts, for the
// same reason: the mint route sends exactly this, and the live-fire probe
// (tests/live-fire/interpreter.measure.ts) drives exactly this, so what is
// measured is what ships.
//
// Nothing here reads the database or the request. The briefing arrives
// already assembled.

import { contextTokenLimitFromEnv, truncationCap } from "@/lib/realtime/truncation";
import type { InterpreterDirection, InterpreterPair } from "./briefing";
import { transcriberTakesLanguagesHint } from "./engine";

// ── The context cap (the PR #42 pattern) ───────────────────────────────────
// A realtime session re-reads "the conversation so far", as AUDIO, on every
// response — uncapped, that is a bill quadratic in how long the dinner runs
// (lib/realtime/truncation.ts has the measurements). So the session carries
// the same declarative `retention_ratio` truncation /call, /live and the
// table carry, counted AFTER the instructions: the briefing is never
// truncated (it is the prompt, and it is what the prompt cache holds).
//
// 600, where the table's push-to-talk turns use 100. The interpreter is asked
// to do something those turns are told not to: follow the thread — who "she"
// is, what "it" was, the joke being answered. 600 tokens is roughly the last
// minute of talk (user audio bills 10 tokens/s, the model's own speech 20/s),
// which is enough for the referent of a pronoun and nowhere near a dinner.
// The cost of the choice is bounded and flat: at most 600 tokens re-read per
// response, most of it from cache at $0.40/M rather than $32/M, because
// retention_ratio 0.8 prunes in steps and the prefix stays stable in between.
//
//     TAOS_INTERPRETER_CONTEXT_TOKENS=600      ("off" = uncapped; do not)
export const INTERPRETER_CONTEXT_TOKEN_LIMIT = contextTokenLimitFromEnv(
  process.env.TAOS_INTERPRETER_CONTEXT_TOKENS,
  600
);

/** Two minutes, same reasoning as every other mint: a secret is spendable. */
export const INTERPRETER_SECRET_TTL_SECONDS = 120;

/**
 * One response's ceiling, in output tokens. The model's speech bills 20
 * tokens a second, so 2,400 is two minutes of continuous interpretation of
 * ONE thought — far past any real turn, and a hard stop on a runaway.
 */
export const INTERPRETER_MAX_OUTPUT_TOKENS = 2400;

export type SemanticEagerness = "low" | "medium" | "high" | "auto";

/**
 * How quickly the model decides a thought is finished.
 *
 *     TAOS_INTERPRETER_EAGERNESS=auto|low|medium|high
 *
 * semantic_vad, not the table's server_vad: nobody presses a button to say
 * "I'm done", so the end of a turn has to be read from what was SAID, not
 * from 550 ms of quiet — a person looking for a word at dinner is not
 * finished. `auto` is the API's default (= medium).
 */
export function interpreterEagerness(
  raw: string | undefined = process.env.TAOS_INTERPRETER_EAGERNESS
): SemanticEagerness {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : "auto";
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/**
 * gpt-realtime-2.x is a reasoning model. `low` is the API's default and is
 * left alone unless the knob says otherwise — an interpreter mostly needs to
 * be fast, but "who is 'she'?" is exactly the kind of thing a little thought
 * gets right.
 *
 *     TAOS_INTERPRETER_REASONING=minimal|low|medium|high
 */
export function interpreterReasoning(
  raw: string | undefined = process.env.TAOS_INTERPRETER_REASONING
): ReasoningEffort | null {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "minimal" || v === "low" || v === "medium" || v === "high" ? v : null;
}

export interface OpenAIRealtimeSessionOptions {
  model: string;
  /** The assembled briefing (lib/interpreter/briefing.ts). */
  instructions: string;
  voice: string;
  transcribeModel: string;
  /** The table's two languages — a hint for the caption transcriber. */
  pair: InterpreterPair;
  eagerness?: SemanticEagerness;
  reasoning?: ReasoningEffort | null;
  /** `null` removes the cap. Only the measurement probe passes null. */
  contextTokenLimit?: number | null;
}

/**
 * A GA Realtime session that LISTENS CONTINUOUSLY and SPEAKS: audio in, audio
 * out, the server deciding where a turn ends and answering it by itself.
 */
export function buildOpenAIRealtimeSession(opts: OpenAIRealtimeSessionOptions): Record<string, unknown> {
  const cap =
    opts.contextTokenLimit === undefined ? INTERPRETER_CONTEXT_TOKEN_LIMIT : opts.contextTokenLimit;
  const reasoning = opts.reasoning ?? null;

  return {
    type: "realtime",
    model: opts.model,
    instructions: opts.instructions,
    // AUDIO: the model's own voice is the product here. The transcript of
    // what it says arrives beside the audio and is what the captions show.
    output_modalities: ["audio"],
    max_output_tokens: INTERPRETER_MAX_OUTPUT_TOKENS,
    ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
    // THE cost guard. See INTERPRETER_CONTEXT_TOKEN_LIMIT above.
    ...(cap === null ? {} : { truncation: truncationCap(cap) }),
    audio: {
      input: {
        // The phone lies flat BETWEEN two people — nobody leans over it to
        // talk, which is the far-field case (a laptop or a conference mic),
        // not the near-field one the push-to-talk table has.
        noise_reduction: { type: "far_field" },
        transcription: {
          model: opts.transcribeModel,
          ...(transcriberTakesLanguagesHint(opts.transcribeModel)
            ? { languages: [opts.pair.a, opts.pair.b] }
            : {})
        },
        turn_detection: {
          type: "semantic_vad",
          eagerness: opts.eagerness ?? "auto",
          // No button: the server answers each finished thought by itself.
          create_response: true,
          // BARGE-IN: speaking while the interpreter is speaking cuts it off.
          interrupt_response: true
        }
      },
      output: { voice: opts.voice }
    }
  };
}

/**
 * gpt-realtime-translate's session. The whole of it: the model's
 * `session.update` accepts a target language, a transcriber and noise
 * reduction and NOTHING else — no instructions, no voice, no turn detection
 * (it streams continuously). So there is no briefing here, by the API's
 * design, and the mode says so on screen.
 */
export function buildOpenAITranslateSession(opts: {
  model: string;
  direction: InterpreterDirection;
  transcribeModel: string;
}): Record<string, unknown> {
  return {
    model: opts.model,
    audio: {
      input: {
        transcription: { model: opts.transcribeModel },
        noise_reduction: { type: "far_field" }
      },
      output: { language: opts.direction.target }
    }
  };
}

/**
 * Gemini Live's setup message, as it is locked into the one-use ephemeral
 * token. AUDIO out (a native-audio Live model has no other modality); the
 * captions are the two transcriptions. The sliding window is Gemini's
 * equivalent of the cap above: the Live API re-bills the accumulated context
 * on every turn "up to your configured context window size".
 */
export const GEMINI_INTERPRETER_TRIGGER_TOKENS = 4000;
export const GEMINI_INTERPRETER_TARGET_TOKENS = 2000;

export function buildGeminiInterpreterSetup(opts: {
  model: string;
  instructions: string;
  voice: string;
}): Record<string, unknown> {
  return {
    model: `models/${opts.model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } }
    },
    systemInstruction: { parts: [{ text: opts.instructions }] },
    realtimeInputConfig: {
      // BARGE-IN: the API's default, spelled out because the mode depends on it.
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS"
    },
    contextWindowCompression: {
      triggerTokens: GEMINI_INTERPRETER_TRIGGER_TOKENS,
      slidingWindow: { targetTokens: GEMINI_INTERPRETER_TARGET_TOKENS }
    },
    // On `setup`, not inside generationConfig (lib/tabletop/geminiSession.ts:
    // the spike found the other placement answers 1007).
    inputAudioTranscription: {},
    outputAudioTranscription: {}
  };
}
