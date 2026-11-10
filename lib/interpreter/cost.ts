// What one Interpreter-mode session cost, from the numbers the providers
// report — the lib/call/cost.ts idea, for six engines that bill three
// different ways. Isomorphic and pure: the phone tallies with it, the usage
// route prices with it, the probe reports with it. One arithmetic.
//
// ── NUMBERS ONLY ───────────────────────────────────────────────────────────
// Nothing in this file can hold a word anybody said. The tally is counters,
// the summary the phone posts is parsed field by field into numbers and two
// closed enums, and the log line is built from those — so no transcript, no
// briefing and no context block can reach the Vercel log through it.
//
// Prices read from the providers' own pages on 2026-11-09:
//   developers.openai.com/api/docs/models/gpt-realtime-2.1 (+ -mini,
//   gpt-realtime-translate, gpt-live-1) and aistudio.google.com/docs/pricing.

import type { RealtimeUsage } from "@/lib/call/cost";
import { engineBillsByTheMinute, parseEngine, type InterpreterEngine } from "./engine";
import { DEFAULT_INTERPRETER_STYLE, parseStyle, type InterpreterStyle } from "./mediator";

/** Dollars per 1M tokens. */
export interface TokenRates {
  textIn: number;
  textInCached: number;
  audioIn: number;
  audioInCached: number;
  textOut: number;
  audioOut: number;
}

export const OPENAI_REALTIME_RATES: Record<"flagship" | "mini", TokenRates> = {
  // gpt-realtime-2.1 (and gpt-realtime-2): audio is priced as gpt-realtime
  // was; text OUT went from $16 to $24.
  flagship: { textIn: 4, textInCached: 0.4, audioIn: 32, audioInCached: 0.4, textOut: 24, audioOut: 64 },
  // gpt-realtime-2.1-mini
  mini: { textIn: 0.6, textInCached: 0.06, audioIn: 10, audioInCached: 0.3, textOut: 2.4, audioOut: 20 }
};

/**
 * gemini-3.8-live. Google documents no caching on Live models, so the cached
 * rates equal the uncached ones and `cached_tokens` stays 0.
 */
export const GEMINI_LIVE_RATES: TokenRates = {
  textIn: 0.75,
  textInCached: 0.75,
  audioIn: 3,
  audioInCached: 3,
  textOut: 4.5,
  audioOut: 12
};

/** gpt-realtime-translate: flat, by audio duration, PER SESSION (= per leg). */
export const OPENAI_TRANSLATE_USD_PER_MINUTE = 0.034;

/**
 * gpt-live-1: flat, billed per second of SESSION — silence included, muting
 * does not stop it — and per session (= per leg). No backend model is
 * configured for an interpreter, so there is no second line item.
 */
export const OPENAI_LIVE_USD_PER_MINUTE = 0.05;

/**
 * grok-voice-3.0: flat $0.08 per minute ($4.80/h), per session (= per leg).
 * xAI's pricing page does not say what the meter counts; their own
 * live-interpreter recipe measured it as "the time since the first audio
 * arrived, silences included", and each `response.done` reports the running
 * total (`usage.billable_audio_seconds`), which is what the tally reads.
 * (docs.x.ai/developers/pricing, read 2026-11-09.)
 */
export const GROK_VOICE_USD_PER_MINUTE = 0.08;

/**
 * ElevenLabs Realtime: $0.08 per connected minute, per session (= PER LEG) —
 * so a two-leg table is $0.16 a minute, which is what the meter shows and
 * what ElevenLabs charges. Checked against their own records on 2026-11-09
 * (GET /v1/convai/conversations/<id> for the two sessions of one probe run,
 * tests/live-fire/interpreter-engines.measure.ts — every Realtime session is
 * a conversation there, `authorization_method: "realtime"`):
 *
 *   realtime_audio   0.9685 min → $0.07748   = $0.0800/min, by the second,
 *                    for the whole 58 s connection — the quiet stretches
 *                    included (none of them ran past ten seconds, so the
 *                    discount ElevenLabs advertises for long silences was not
 *                    exercised and is not credited here).
 *   llm (Mini)       $0.0014 and $0.0020 for the two sessions — about 2 % on
 *                    top. The wire protocol does not report it (`response.
 *                    done` carries no usage), so the meter leaves it out.
 *   plan             `free_minutes_consumed: 0`, `is_burst: false`: the
 *                    account's included minutes were not drawn on, and the
 *                    2× burst rate did not apply to two sessions at once.
 *
 * So the figure is the bill to within about 2 %, a little under. Tom's table
 * of the same morning read $0.19 at 1:11 — 71 s × 2 legs × $0.08/min. The
 * "$0.08 a minute" people remember is this constant; a table is two of them
 * (usdPerTableMinute). TAOS_INTERPRETER_LEGS=1 halves it and costs the second
 * voice.
 */
export const ELEVENLABS_REALTIME_USD_PER_MINUTE = 0.08;

/** The flat rate of an engine that bills the clock; null for a token engine. */
export function usdPerMinute(engine: InterpreterEngine): number | null {
  if (!engineBillsByTheMinute(engine)) return null;
  if (engine === "openai-translate") return OPENAI_TRANSLATE_USD_PER_MINUTE;
  if (engine === "openai-live") return OPENAI_LIVE_USD_PER_MINUTE;
  if (engine === "grok-voice") return GROK_VOICE_USD_PER_MINUTE;
  if (engine === "elevenlabs-realtime") return ELEVENLABS_REALTIME_USD_PER_MINUTE;
  return null;
}

/**
 * What a TABLE costs per minute on an engine that bills the clock: the
 * per-session rate times the sessions open at once. This — not usdPerMinute —
 * is the number to quote for a dinner; quoting the per-leg rate for a two-leg
 * table is how "$0.08 a minute" turned into a meter reading double.
 */
export function usdPerTableMinute(engine: InterpreterEngine, legs: number): number | null {
  const flat = usdPerMinute(engine);
  return flat === null ? null : flat * Math.max(1, legs);
}

/** gpt-transcribe, for the captions of what each person said. By duration. */
export const CAPTION_TRANSCRIBE_USD_PER_MINUTE = 0.0045;

/** The model's own speech: 1 token / 50 ms. A person's: 1 token / 100 ms. */
export const OUTPUT_AUDIO_TOKENS_PER_SECOND = 20;
export const INPUT_AUDIO_TOKENS_PER_SECOND = 10;

export function tokenRatesFor(engine: InterpreterEngine, model: string): TokenRates | null {
  if (engine === "gemini-live") return GEMINI_LIVE_RATES;
  if (engine === "openai-realtime") {
    return /mini/i.test(model) ? OPENAI_REALTIME_RATES.mini : OPENAI_REALTIME_RATES.flagship;
  }
  return null;
}

/** Why a session ended. A closed set — it goes in the log line. */
export type InterpreterStop = "user" | "cap" | "idle" | "error" | "left";
const STOPS: readonly InterpreterStop[] = ["user", "cap", "idle", "error", "left"];

/** Everything one session has spent, across all of its legs. */
export interface InterpreterTally {
  engine: InterpreterEngine;
  model: string;
  startedAtMs: number;
  /** Provider sessions open at once (2 = one per direction). */
  legs: number;
  responses: number;
  textInTokens: number;
  audioInTokens: number;
  /** Cached tokens are a SUBSET of the input tokens (lib/call/cost.ts). */
  cachedTextInTokens: number;
  cachedAudioInTokens: number;
  textOutTokens: number;
  audioOutTokens: number;
  /** Seconds of speech the caption transcriber was billed for, all legs. */
  transcribedSeconds: number;
  /** Seconds a per-minute engine billed, SUMMED over legs. */
  billedSeconds: number;
  bargeIns: number;
  errors: number;
  /** The style the session was briefed in. Absent = the interpreter. */
  style?: InterpreterStyle;
}

export function emptyInterpreterTally(
  engine: InterpreterEngine,
  model: string,
  startedAtMs: number,
  legs = 1
): InterpreterTally {
  return {
    engine,
    model,
    startedAtMs,
    legs,
    responses: 0,
    textInTokens: 0,
    audioInTokens: 0,
    cachedTextInTokens: 0,
    cachedAudioInTokens: 0,
    textOutTokens: 0,
    audioOutTokens: 0,
    transcribedSeconds: 0,
    billedSeconds: 0,
    bargeIns: 0,
    errors: 0
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Fold one OpenAI `response.done` usage payload into the tally. */
export function addUsage(tally: InterpreterTally, usage: RealtimeUsage | null | undefined): InterpreterTally {
  if (!usage) return tally;
  const inDetails = usage.input_token_details ?? {};
  const cached = inDetails.cached_tokens_details ?? {};
  const outDetails = usage.output_token_details ?? {};
  return {
    ...tally,
    responses: tally.responses + 1,
    textInTokens: tally.textInTokens + num(inDetails.text_tokens),
    audioInTokens: tally.audioInTokens + num(inDetails.audio_tokens),
    cachedTextInTokens: tally.cachedTextInTokens + num(cached.text_tokens),
    cachedAudioInTokens: tally.cachedAudioInTokens + num(cached.audio_tokens),
    textOutTokens: tally.textOutTokens + num(outDetails.text_tokens),
    audioOutTokens: tally.audioOutTokens + num(outDetails.audio_tokens)
  };
}

/** One Gemini `usageMetadata` message. Each is a DELTA (the 10/21 spike). */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  responseTokenCount?: number;
  promptTokensDetails?: { modality?: string; tokenCount?: number }[];
  responseTokensDetails?: { modality?: string; tokenCount?: number }[];
}

function byModality(
  details: { modality?: string; tokenCount?: number }[] | undefined,
  total: number
): { text: number; audio: number } {
  if (!Array.isArray(details) || details.length === 0) return { text: 0, audio: total };
  let text = 0;
  let audio = 0;
  for (const d of details) {
    const n = num(d?.tokenCount);
    if (String(d?.modality ?? "").toUpperCase() === "TEXT") text += n;
    else audio += n;
  }
  return { text, audio };
}

export function addGeminiUsage(
  tally: InterpreterTally,
  usage: GeminiUsageMetadata | null | undefined
): InterpreterTally {
  if (!usage) return tally;
  const prompt = byModality(usage.promptTokensDetails, num(usage.promptTokenCount));
  const response = byModality(usage.responseTokensDetails, num(usage.responseTokenCount));
  if (prompt.text + prompt.audio + response.text + response.audio === 0) return tally;
  return {
    ...tally,
    responses: tally.responses + (response.text + response.audio > 0 ? 1 : 0),
    textInTokens: tally.textInTokens + prompt.text,
    audioInTokens: tally.audioInTokens + prompt.audio,
    textOutTokens: tally.textOutTokens + response.text,
    audioOutTokens: tally.audioOutTokens + response.audio
  };
}

/** Dollars this session has spent so far, by its engine's own billing. */
export function estimateUsd(tally: InterpreterTally): number {
  const captions = (tally.transcribedSeconds / 60) * CAPTION_TRANSCRIBE_USD_PER_MINUTE;
  const flat = usdPerMinute(tally.engine);
  if (flat !== null) return (tally.billedSeconds / 60) * flat;
  const R = tokenRatesFor(tally.engine, tally.model);
  if (!R) return 0;
  const uncachedText = Math.max(0, tally.textInTokens - tally.cachedTextInTokens);
  const uncachedAudio = Math.max(0, tally.audioInTokens - tally.cachedAudioInTokens);
  const model =
    (uncachedText * R.textIn +
      tally.cachedTextInTokens * R.textInCached +
      uncachedAudio * R.audioIn +
      tally.cachedAudioInTokens * R.audioInCached +
      tally.textOutTokens * R.textOut +
      tally.audioOutTokens * R.audioOut) /
    1e6;
  return model + (tally.engine === "openai-realtime" ? captions : 0);
}

// ── The summary the phone posts, and the line the server writes ────────────

export interface InterpreterSummary {
  engine: InterpreterEngine;
  secs: number;
  legs: number;
  responses: number;
  in_tokens: number;
  out_tokens: number;
  cached_tokens: number;
  text_in_tokens: number;
  audio_in_tokens: number;
  cached_text_in_tokens: number;
  cached_audio_in_tokens: number;
  text_out_tokens: number;
  audio_out_tokens: number;
  transcribed_secs: number;
  billed_secs: number;
  barge_ins: number;
  errors: number;
  stop: InterpreterStop;
  /** A closed set, like `engine` and `stop` — it goes in the log line. */
  style: InterpreterStyle;
}

export function summarizeTally(tally: InterpreterTally, nowMs: number, stop: InterpreterStop): InterpreterSummary {
  return {
    engine: tally.engine,
    secs: Math.max(0, Math.round((nowMs - tally.startedAtMs) / 1000)),
    legs: tally.legs,
    responses: tally.responses,
    in_tokens: tally.textInTokens + tally.audioInTokens,
    out_tokens: tally.textOutTokens + tally.audioOutTokens,
    cached_tokens: tally.cachedTextInTokens + tally.cachedAudioInTokens,
    text_in_tokens: tally.textInTokens,
    audio_in_tokens: tally.audioInTokens,
    cached_text_in_tokens: tally.cachedTextInTokens,
    cached_audio_in_tokens: tally.cachedAudioInTokens,
    text_out_tokens: tally.textOutTokens,
    audio_out_tokens: tally.audioOutTokens,
    transcribed_secs: Math.round(tally.transcribedSeconds),
    billed_secs: Math.round(tally.billedSeconds),
    barge_ins: tally.bargeIns,
    errors: tally.errors,
    stop,
    style: tally.style ?? DEFAULT_INTERPRETER_STYLE
  };
}

/** A count the phone reported: a finite, non-negative number, bounded. */
function count(value: unknown, max = 1e9): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(max, Math.round(value));
}

/**
 * Read a posted summary. Every field is rebuilt as a number or matched
 * against a closed set; anything else — a string where a number belongs, an
 * unknown key, a transcript somebody tried to smuggle in — is dropped or
 * refuses the whole summary. This is the only way a client's words could
 * reach the log, and they cannot.
 */
export function parseInterpreterSummary(raw: unknown): InterpreterSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const engine = parseEngine(r.engine);
  const stop = STOPS.find((s) => s === r.stop);
  if (!engine || !stop) return null;
  const fields = [
    "secs",
    "legs",
    "responses",
    "text_in_tokens",
    "audio_in_tokens",
    "cached_text_in_tokens",
    "cached_audio_in_tokens",
    "text_out_tokens",
    "audio_out_tokens",
    "transcribed_secs",
    "billed_secs",
    "barge_ins",
    "errors"
  ] as const;
  const n = {} as Record<(typeof fields)[number], number>;
  for (const f of fields) {
    const v = count(r[f]);
    if (v === null) return null;
    n[f] = v;
  }
  return {
    engine,
    stop,
    // Matched against the closed set; anything else — absent (a phone on the
    // build before styles existed), a typo, a sentence — is the default.
    style: parseStyle(r.style) ?? DEFAULT_INTERPRETER_STYLE,
    ...n,
    legs: Math.max(1, Math.min(4, n.legs)),
    // Derived here, never trusted from the client.
    in_tokens: n.text_in_tokens + n.audio_in_tokens,
    out_tokens: n.text_out_tokens + n.audio_out_tokens,
    cached_tokens: n.cached_text_in_tokens + n.cached_audio_in_tokens
  };
}

/** The same arithmetic as estimateUsd, from a parsed summary. */
export function summaryUsd(summary: InterpreterSummary, model: string): number {
  return estimateUsd({
    engine: summary.engine,
    model,
    startedAtMs: 0,
    legs: summary.legs,
    responses: summary.responses,
    textInTokens: summary.text_in_tokens,
    audioInTokens: summary.audio_in_tokens,
    cachedTextInTokens: summary.cached_text_in_tokens,
    cachedAudioInTokens: summary.cached_audio_in_tokens,
    textOutTokens: summary.text_out_tokens,
    audioOutTokens: summary.audio_out_tokens,
    transcribedSeconds: summary.transcribed_secs,
    billedSeconds: summary.billed_secs,
    bargeIns: summary.barge_ins,
    errors: summary.errors,
    style: summary.style
  });
}

/**
 * The line Tom greps for. Flat key=value; the first eight keys are the ones
 * the brief names, in its order. `model` is the SERVER's — resolved from the
 * engine by the route, never a string the phone sent.
 */
export function interpreterLogLine(summary: InterpreterSummary, model: string): string {
  return [
    "[taos-interpreter]",
    `engine=${summary.engine}`,
    `model=${model}`,
    `secs=${summary.secs}`,
    `in_tokens=${summary.in_tokens}`,
    `out_tokens=${summary.out_tokens}`,
    `cached_tokens=${summary.cached_tokens}`,
    `est_usd=${summaryUsd(summary, model).toFixed(4)}`,
    `barge_ins=${summary.barge_ins}`,
    `legs=${summary.legs}`,
    `responses=${summary.responses}`,
    `audio_in_tokens=${summary.audio_in_tokens}`,
    `audio_out_tokens=${summary.audio_out_tokens}`,
    `billed_secs=${summary.billed_secs}`,
    `errors=${summary.errors}`,
    `stop=${summary.stop}`,
    `style=${summary.style}`
  ].join(" ");
}

/** "$0.34" — a dinner is not a thousand-dollar object. */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}
