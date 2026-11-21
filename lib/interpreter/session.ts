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
import type { InterpreterStyle } from "./mediator";

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

/**
 * The Deal persona's cap (Mediator v2, 2026-11-10). Its TERMS LEDGER is the
 * model's own memory of what was agreed — and a session capped at 600 tokens
 * remembers about the last MINUTE. A ledger that forgets a term agreed ten
 * minutes ago is worse than no ledger, so a Deal session is allowed to re-read
 * ten times as much: 6,000 tokens, roughly the last ten minutes of talk.
 *
 * It is still a cap, and still flat — at most 6,000 tokens re-read per
 * response. In the probe's ten-turn negotiation (tests/live-fire/
 * mediator-v2.measure.ts) all but ~150 tokens of each re-read came from
 * cache; what a FULL window costs over a long session is an estimate, not a
 * measurement — a few dollars more per half hour at worst. What it does NOT
 * do is make the ledger permanent: a point agreed longer ago than
 * the window and never read back since is gone. Every read-back puts the
 * whole list at the front of the window again.
 *
 *     TAOS_INTERPRETER_DEAL_CONTEXT_TOKENS=6000      ("off" = uncapped)
 *
 * Only gpt-realtime-2.1 has this cap at all; GPT-Live manages its own context.
 */
export const INTERPRETER_DEAL_CONTEXT_TOKEN_LIMIT = contextTokenLimitFromEnv(
  process.env.TAOS_INTERPRETER_DEAL_CONTEXT_TOKENS,
  6000
);

/** The cap a session of this style runs under. */
export function interpreterContextTokenLimit(style: InterpreterStyle | undefined): number | null {
  return style === "deal" ? INTERPRETER_DEAL_CONTEXT_TOKEN_LIMIT : INTERPRETER_CONTEXT_TOKEN_LIMIT;
}

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

// ── Grok Voice (xAI) ───────────────────────────────────────────────────────
// The OpenAI Realtime wire protocol with xAI's differences, each read from
// docs.x.ai on 2026-11-09 (speech-to-speech guide + voice-realtime.ws.json):
//
//   · `voice` and `turn_detection` sit at the TOP of the session, not under
//     `audio.output` / `audio.input`.
//   · turn detection is `server_vad` or nothing — no semantic VAD, and it is
//     OFF until asked for, so it is asked for here. Barge-in comes with it.
//   · there is no WebRTC, so there is no SDP to negotiate a format in: the
//     PCM rates are stated.
//   · the caption transcriber is `grok-transcribe`; its language hint takes
//     ONE regional code (a bare "es" is silently ignored), and a table has
//     two languages, so no hint is sent and it detects.
//   · no `truncation`, no `max_output_tokens`: it bills the clock, flat, so
//     context growth is not a line item.
//
// The whole of this goes in the browser's first `session.update` — xAI's
// client secret can bind only `model` and `reasoning.effort` (see the mint
// route for what that means for the briefing).

/**
 * The rate the socket engines are sent the microphone at: 24 kHz s16le mono.
 * ElevenLabs Realtime takes nothing else ("audio/pcm input must be 24000 Hz"
 * — its mint refuses 16000); Grok takes anything from 8 to 48 kHz. One rate
 * for both, so the client has one tap.
 */
export const INTERPRETER_WS_INPUT_RATE = 24_000;
/** What the socket engines are asked to speak at, and what the player plays. */
export const INTERPRETER_WS_OUTPUT_RATE = 24_000;

export const GROK_TRANSCRIBE_MODEL = "grok-transcribe";

export function buildGrokSessionUpdate(opts: {
  instructions: string;
  voice: string;
  /**
   * Sent HERE as well as at the mint and on the socket URL. xAI's default is
   * `high`, and its two pages disagree on whether a client secret can bind
   * anything (the realtime reference documents `session` on the mint; the
   * ephemeral-tokens page says the endpoint "does not support session") — so
   * after Tom's table test of 2026-11-09, where Grok answered once and late,
   * the effort is stated in all three documented places and the diagnostics
   * timeline records which one the provider echoes (lib/interpreter/
   * timeline.ts, `reasoning=`).
   */
  reasoning?: "none" | "high";
}): Record<string, unknown> {
  return {
    instructions: opts.instructions,
    voice: opts.voice,
    ...(opts.reasoning ? { reasoning: { effort: opts.reasoning } } : {}),
    turn_detection: { type: "server_vad" },
    audio: {
      input: {
        format: { type: "audio/pcm", rate: INTERPRETER_WS_INPUT_RATE },
        transcription: { model: GROK_TRANSCRIBE_MODEL }
      },
      output: { format: { type: "audio/pcm", rate: INTERPRETER_WS_OUTPUT_RATE } }
    }
  };
}

/** What IS bound to a Grok client secret: the model and the reasoning effort. */
export function buildGrokSecretSession(opts: {
  model: string;
  reasoning: "none" | "high";
}): Record<string, unknown> {
  return { model: opts.model, reasoning: { effort: opts.reasoning } };
}

// ── ElevenLabs Realtime ────────────────────────────────────────────────────
// Their OpenAI-compatible Realtime API (elevenlabs.io/docs/eleven-agents/
// guides/openai-realtime-compatibility, read 2026-11-09): no agent to create
// in the dashboard — "a `model` string selects the agent's behavior directly"
// — and "the session configuration you send when minting the client secret is
// the authoritative initial session for that credential". So, unlike Grok,
// the briefing and the VOICE are locked in on the server and the browser is
// handed a secret and nothing else.
//
// `audio.output.voice` is documented only as "string, default: brian". It
// takes an account voice ID — including a cloned one: probed 2026-11-09 with
// the founders' two clones (tests/live-fire/interpreter-engines.measure.ts).
//
// `max_duration_seconds` DEFAULTS TO 600: left alone, ElevenLabs hangs up a
// dinner at ten minutes. It is set from our own cap, plus the cap's grace.
//
// ── What was measured on 2026-11-09 ────────────────────────────────────────
// tests/live-fire/interpreter-engines.measure.ts: these builders, a six-line
// synthetic table (two speakers), clean speech, a wired connection.
//
// LATENCY. From the speaker's last audible sample to the first audio frame:
// 0.7–2.0 s, median ≈ 1.3 s, over ~70 turns — and there is nothing left in
// this session object to make it shorter:
//
//   · the model is already Mini, their "lowest latency and cost";
//   · turn detection is `semantic_vad` or manual — the mint answers 422
//     "server_vad is not supported; use semantic_vad or null (manual)";
//   · eagerness `high` measured the same as `medium`;
//   · the output is PCM at 24 kHz with no rate, codec or latency field, and
//     the voice model and transcriber are theirs (eleven_v4_turbo,
//     scribe_realtime — read back from the conversation record).
//
// The provider sends speech_stopped, committed, response.created and the
// first audio frame within a few milliseconds of each other: the turn
// decision, the transcript, the text and the first sound are all finished
// before the socket hears about any of them. That wait is the cascade.
//
// TWO LEGS. Their semantic turn-taking decides whether the AGENT should
// answer, and a leg told to keep quiet for the other person's language often
// decides it should not: no speech_stopped, no commit, nothing. What it
// skipped is not forgotten — it is glued onto the next turn it DOES take. So
// the Spanish→English leg, after three English sentences, said all three
// again in English and then the interpretation; the echo guard (rightly)
// refused the lot; and the Spanish speaker was never interpreted at all.
// Lines whose meaning reached the other language, of those spoken:
//
//   two legs, as first shipped        7 of 12    Spanish→English 0 of 4
//   + the other legs cleared on a     43 of 60   Spanish→English 17 of 20
//     turn (client.ts,                           (eagerness medium 19/30,
//     clearPeersOnTurn)                          high 24/30 — not a
//                                                difference at this size)
//   + eagerness high, NOT cleared     2 of 6     Spanish→English 0 of 2
//   ONE leg (TAOS_INTERPRETER_LEGS=1) 10 of 12   Spanish→English 2 of 4, and
//     — one voice, half the price                a third cut off half-way
//
// The clear is what moved it; it does not make two legs reliable. The losses
// that remain are the same glue surviving a clear, and Mini ANSWERING the
// speaker instead of interpreting ("Estoy aquí, listo para interpretar").
// A forced commit on the quiet leg was tried and made it invent lines.

/** ElevenLabs' bounds for `max_duration_seconds`. */
const ELEVENLABS_MIN_DURATION_S = 60;
const ELEVENLABS_MAX_DURATION_S = 7200;

export function buildElevenLabsRealtimeSession(opts: {
  model: string;
  instructions: string;
  /** An ElevenLabs voice ID (lib/tts/voice.ts). */
  voice: string;
  /**
   * The ONE language code the session is given (`audio.input.transcription.
   * language`) — ElevenLabs uses it for its transcriber. Null leaves it out.
   */
  language: string | null;
  /** Our session cap, in seconds; the provider's own limit is set past it. */
  maxSeconds: number;
  eagerness?: SemanticEagerness;
}): Record<string, unknown> {
  const eagerness = opts.eagerness && opts.eagerness !== "auto" ? opts.eagerness : "medium";
  const duration = Math.min(
    ELEVENLABS_MAX_DURATION_S,
    Math.max(ELEVENLABS_MIN_DURATION_S, Math.round(opts.maxSeconds) + 60)
  );
  return {
    type: "realtime",
    model: opts.model,
    instructions: opts.instructions,
    output_modalities: ["audio"],
    max_duration_seconds: duration,
    audio: {
      input: {
        format: { type: "audio/pcm", rate: INTERPRETER_WS_INPUT_RATE },
        ...(opts.language ? { transcription: { language: opts.language } } : {}),
        turn_detection: {
          type: "semantic_vad",
          eagerness,
          create_response: true,
          interrupt_response: true
        }
      },
      output: { format: { type: "audio/pcm" }, voice: opts.voice }
    }
  };
}
