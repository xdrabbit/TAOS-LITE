// What a translated call actually costs, in dollars, from the numbers the
// providers report rather than from an estimate of how long anyone talked.
//
// /call was pulled from RC1 partly because nobody could answer "what does a
// minute of this cost?" — the July 14/22 OpenAI spikes were noticed on a bill,
// weeks late, with no way to attribute them. Guessing from wall-clock
// duration would have been wrong in an interesting way: a Realtime session
// does NOT bill the audio you stream it, it bills the audio it commits plus
// every re-read of the conversation so far, and the second half of that
// sentence is the one that grows.
//
// So this module prices REAL usage. Every `response.done` carries a usage
// object; the client adds each one here, and the meter on screen and the line
// in the Vercel log are the same arithmetic. Measured against a live
// gpt-realtime session on 2026-08-27, five consecutive Spanish utterances:
//
//   truncation           billed audio in   per-turn trend    5-turn model cost
//   ------------------   ---------------   ---------------   -----------------
//   default ("auto")     209% of speech    49→100→164→227    $0.0154
//   post_instructions    148%              ~100–126          $0.0245
//     = 200
//   post_instructions     66%              flat ~52          $0.0129
//     = 100  ← shipped
//
// The percentages are of the audio actually SPOKEN. Over 209% means the model
// re-read earlier turns; that column is what a long call pays for a context
// an interpreter never needed, and it climbs with every turn until the cap
// stops it. The 100-token cap is what makes per-turn cost flat instead of
// linear, and the Italian translations at 100 were word-for-word as good as
// at 200 — see docs/realtime-cost-model.md for the full run.

/** Dollars per 1M tokens. OpenAI pricing, read 2026-08-27. */
export const REALTIME_RATES_USD_PER_MTOK = {
  textIn: 4,
  textInCached: 0.4,
  audioIn: 32,
  audioInCached: 0.4,
  textOut: 16,
  audioOut: 64
} as const;

/**
 * gpt-4o-mini-transcribe, billed per minute of audio it hears. OpenAI quotes
 * $0.003/minute directly rather than in tokens, so it is priced that way.
 */
export const TRANSCRIBE_USD_PER_MINUTE = 0.003;

/**
 * ElevenLabs flash/turbo v2.5, $0.05 per 1,000 characters (API rate, 2026-08-27
 * — the same across Creator/Pro/Scale/Business; the plans differ in included
 * characters, not in price per character). This is the one number here that
 * depends on Tom's plan rather than on a public list, so it is the one to
 * re-check if the meter ever disagrees with the invoice.
 */
export const ELEVENLABS_USD_PER_1K_CHARS = 0.05;

/**
 * gpt-4o-mini-tts, $12 per 1M audio output tokens, which the same measurement
 * put at ~25 tokens per second of speech. Only used when a phone falls back to
 * the OpenAI engine (no personal-voice unlock) — founders get the clones.
 */
export const OPENAI_TTS_USD_PER_MTOK = 12;
export const OPENAI_TTS_TOKENS_PER_SECOND = 25;

/** Audio tokens per second, both directions: the API bills 1 token / 100 ms. */
export const AUDIO_TOKENS_PER_SECOND = 10;

/** The raw `response.usage` shape, as gpt-realtime sends it. */
export interface RealtimeUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

/** Everything one call has spent, so far, on one phone. */
export interface CallSpend {
  responses: number;
  textInTokens: number;
  cachedTextInTokens: number;
  audioInTokens: number;
  cachedAudioInTokens: number;
  textOutTokens: number;
  audioOutTokens: number;
  /** Seconds of speech the input VAD actually committed — what STT bills on. */
  transcribedSeconds: number;
  /** Characters handed to the TTS engine, when the voice is not the model's. */
  ttsCharacters: number;
  ttsEngine: "elevenlabs" | "openai";
}

export function emptySpend(ttsEngine: CallSpend["ttsEngine"] = "elevenlabs"): CallSpend {
  return {
    responses: 0,
    textInTokens: 0,
    cachedTextInTokens: 0,
    audioInTokens: 0,
    cachedAudioInTokens: 0,
    textOutTokens: 0,
    audioOutTokens: 0,
    transcribedSeconds: 0,
    ttsCharacters: 0,
    ttsEngine
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Fold one `response.done` usage payload into the running total.
 *
 * Cached tokens are reported as a SUBSET of the input tokens, not in addition
 * to them (measured: input_tokens 386 = text 337 + audio 49, of which cached
 * 320). Pricing them twice would have overstated a long call by the exact
 * amount the cache was saving, which is the sort of meter that talks you out
 * of the optimisation that is working.
 */
export function addResponseUsage(spend: CallSpend, usage: RealtimeUsage | null | undefined): CallSpend {
  if (!usage) return spend;
  const inDetails = usage.input_token_details ?? {};
  const cached = inDetails.cached_tokens_details ?? {};
  const outDetails = usage.output_token_details ?? {};
  return {
    ...spend,
    responses: spend.responses + 1,
    textInTokens: spend.textInTokens + num(inDetails.text_tokens),
    audioInTokens: spend.audioInTokens + num(inDetails.audio_tokens),
    cachedTextInTokens: spend.cachedTextInTokens + num(cached.text_tokens),
    cachedAudioInTokens: spend.cachedAudioInTokens + num(cached.audio_tokens),
    textOutTokens: spend.textOutTokens + num(outDetails.text_tokens),
    audioOutTokens: spend.audioOutTokens + num(outDetails.audio_tokens)
  };
}

export function addTranscribedSeconds(spend: CallSpend, seconds: number): CallSpend {
  return { ...spend, transcribedSeconds: spend.transcribedSeconds + Math.max(0, seconds) };
}

export function addTtsCharacters(spend: CallSpend, characters: number): CallSpend {
  return { ...spend, ttsCharacters: spend.ttsCharacters + Math.max(0, characters) };
}

/** Dollars spent so far by THIS phone. The partner's phone spends its own. */
export function spendUsd(spend: CallSpend): number {
  const R = REALTIME_RATES_USD_PER_MTOK;
  const uncachedText = Math.max(0, spend.textInTokens - spend.cachedTextInTokens);
  const uncachedAudio = Math.max(0, spend.audioInTokens - spend.cachedAudioInTokens);

  const model =
    (uncachedText * R.textIn +
      spend.cachedTextInTokens * R.textInCached +
      uncachedAudio * R.audioIn +
      spend.cachedAudioInTokens * R.audioInCached +
      spend.textOutTokens * R.textOut +
      spend.audioOutTokens * R.audioOut) /
    1e6;

  const transcription = (spend.transcribedSeconds / 60) * TRANSCRIBE_USD_PER_MINUTE;

  const tts =
    spend.ttsEngine === "elevenlabs"
      ? (spend.ttsCharacters / 1000) * ELEVENLABS_USD_PER_1K_CHARS
      : // OpenAI bills TTS by audio token, so characters are converted through
        // a speaking rate: ~14 characters per second of speech at a normal pace.
        ((spend.ttsCharacters / 14) * OPENAI_TTS_TOKENS_PER_SECOND * OPENAI_TTS_USD_PER_MTOK) / 1e6;

  return model + transcription + tts;
}

/**
 * The number Tom asked to see: dollars per minute of CALL, not per minute of
 * speech. Zero until there is a minute to divide by, so the meter doesn't
 * open on an infinity.
 */
export function usdPerMinute(spend: CallSpend, elapsedSeconds: number): number {
  if (elapsedSeconds < 5) return 0;
  return spendUsd(spend) / (elapsedSeconds / 60);
}

/** "$0.34" — cents matter here; a call is not a thousand-dollar object. */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

/** "$0.058/min", with a third decimal because per-minute lives down there. */
export function formatUsdPerMinute(amount: number): string {
  return `$${amount.toFixed(3)}/min`;
}

/**
 * The line that goes to the Vercel runtime log, and the one Tom greps for.
 * Flat key=value rather than JSON so `[taos-call-cost]` plus eyes is enough.
 */
export function costLogLine(fields: {
  room: string;
  mode: string;
  direction: string;
  seconds: number;
  spend: CallSpend;
  /**
   * How many captions the SCREEN actually put up.
   *
   * The 8/31 field report was "no captions", and this line — with
   * `responses=7` and `tts_chars=244` on it — proved the interpreter had run
   * and spoken, which is most of the answer. It could not say whether
   * anything reached the screen, and that turned out to be the half that was
   * broken. `captions` far below `responses` is now a fact in the log rather
   * than a thing somebody has to reproduce.
   */
  captions?: number;
}): string {
  const { room, mode, direction, seconds, spend, captions } = fields;
  return [
    "[taos-call-cost]",
    `room=${room}`,
    `mode=${mode}`,
    `pair=${direction}`,
    `seconds=${Math.round(seconds)}`,
    `responses=${spend.responses}`,
    `speech_s=${spend.transcribedSeconds.toFixed(1)}`,
    `audio_in_tok=${spend.audioInTokens}`,
    `text_in_tok=${spend.textInTokens}`,
    `cached_tok=${spend.cachedTextInTokens + spend.cachedAudioInTokens}`,
    `text_out_tok=${spend.textOutTokens}`,
    `audio_out_tok=${spend.audioOutTokens}`,
    `tts=${spend.ttsEngine}`,
    `tts_chars=${spend.ttsCharacters}`,
    `captions=${captions ?? 0}`,
    `usd=${spendUsd(spend).toFixed(4)}`,
    `usd_per_min=${usdPerMinute(spend, seconds).toFixed(4)}`
  ].join(" ");
}
