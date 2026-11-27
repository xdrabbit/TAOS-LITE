// Did the transcriber hear words, or make them up?
//
// Found 2026-11-27 while building Dictate (PR #145): two seconds of pure
// silence through transcribeAudio() came back "I need a doctor." and was
// handed on as a normal transcript. Every route's "nothing heard" 422 only
// fired on an EMPTY transcript, and the default transcriber does not return
// an empty one for silence — it writes a sentence. TAOS is pitched to
// pharmacies; a sentence nobody said, translated and spoken aloud, is a
// safety problem and not a quality one.
//
// This file is the judgement, pure, so it can be tested without audio.
// lib/translate/transcribe.ts asks the provider for its own confidence in the
// SAME request (no second call, no added latency) and hands the answer here.
//
// ── What each model gives us (measured 2026-11-27, this repo's prompts) ────
// gpt-4o-transcribe (the default) — `include[]=logprobs` returns a logprob
//   per output token. On silence and room tone it wrote text on 45 of 45
//   runs ("You never know.", "What are you doing?", "Because it is.").
//   Mean token logprob of invented text: −1.02 … −6.69. Of real speech:
//   −0.002 … −0.70, and that includes speech attenuated 45 dB (peak −50
//   dBFS), a whispered line, speech under pink noise, Cantonese, Vietnamese,
//   and one-word turns ("No.", "Gracias.", "Mhm." — the worst, at −0.70).
// gpt-4o-mini-transcribe — returned "" for every silent clip (64 of 64).
//   Same logprobs field, same rule, for the day it does not.
// whisper-1 (the short-transcript retry, /review) — `verbose_json` returns
//   `no_speech_prob` per segment. Silence came back as "Learn English for
//   free www.engvid.com" with no_speech_prob 0.93 … 0.98; real speech was
//   0.003 … 0.53 (the 0.53 is a single "Sí" attenuated 45 dB).
// Anything else (a successor model we have not measured) — no signal is
//   requested, so the guard has only the level and the structural rules.
//
// ── The rules, in the order they are applied ───────────────────────────────
//  1. silent_level — the clip's decoded peak is under −60 dBFS. Where the
//     server can measure it (lib/translate/signalLevel.ts), nothing this
//     quiet is speech: the quietest fixture that still transcribes peaks at
//     −50, and a phone's AGC puts even a whisper far above that.
//  2. no_words — the transcript has no letter or digit ("###", ".", "…"),
//     or is nothing but one bracketed stage direction ("[silence]",
//     "[Inaudible]", "[static]"). All seen from noise; none is something a
//     person said.
//  3. prompt_echo — the transcript is two or more consecutive words of the
//     prompt WE sent ("Transcribe verbatim with natural punctuation.", "If
//     any part", "Spoken English."), or the model's own prompt frame
//     ("context:"). These come back from silence with HIGH confidence
//     (−0.23 … −0.57), so rule 5 cannot catch them. It is a check against
//     our own request, not a list of phrases the model likes to invent.
//  4. no_speech_prob — whisper's own flag, on every segment.
//  5. low_confidence — the mean token logprob is under the threshold. This
//     one is a SUSPICION, not a verdict, and that distinction was paid for:
//     a real "Sí" attenuated 45 dB came back as the single token "Si" at
//     −2.97, because the model had split its belief between "See", "Si" and
//     "Sí" and sampled the unlikely one. One token's logprob measures how
//     the word is SPELLED as much as whether it was said. So a suspect
//     transcript gets a second opinion (lib/translate/transcribe.ts): the
//     same clip through a model from the other end of the family, and it is
//     dropped only when that model hears nothing either.
//       gpt-4o-mini-transcribe is that model: "" on 64 of 64 silent and
//       room-tone runs (and 42 of 42 of louder noise), and words on 138 of
//       138 runs of real speech, including every quiet fixture. When the mini IS the primary, whisper-1 is
//       asked instead and its no_speech_prob answers.
//     A second opinion that fails (timeout, 5xx) drops the turn: unsure and
//     unconfirmed is "try again", never a sentence.
//
// There is deliberately NO blocklist of hallucinated sentences. The model
// invents a different one every run; a list would always be one behind.
//
// ── What this does not catch ───────────────────────────────────────────────
// Real speech followed by a long silence with an invented tail: the mean is
// carried by the real words. And a model that invents with high confidence —
// not seen in 100+ silent runs, but it is the reason the level check exists
// where the server can afford it.

/**
 * Mean token logprob below this is "the model may have been guessing" and
 * buys a second opinion. Real speech of more than one word bottomed out at
 * −0.42 and a lone "Mhm." at −0.70; invented text topped out at −1.02.
 * −0.85 is the midpoint — and because crossing it only ASKS a second model,
 * a real turn that lands under it costs ~400 ms, not the turn.
 */
export const MIN_MEAN_LOGPROB = -0.85;

/**
 * whisper's own no-speech probability, every segment at or above this.
 * Invented: 0.93–0.98. Real: ≤ 0.53. (OpenAI's reference decoder uses 0.6
 * but also requires avg_logprob < −1, which the inventions here do not meet —
 * they are confident, −0.4 … −1.0 — so that pairing would let them through.)
 */
export const MIN_NO_SPEECH_PROB = 0.85;

/** Peak, in dBFS, under which a decoded clip is silence. */
export const SILENT_PEAK_DB = -60;

/**
 * A prompt echo must be at least this many consecutive words. Two, because
 * "Spoken English." came back from room tone at −0.52. One would make every
 * word in the prompt ("never", "audio", "silent") unsayable.
 */
export const ECHO_MIN_WORDS = 2;

export type GuardReason = "silent_level" | "no_words" | "prompt_echo" | "low_confidence" | "no_speech_prob";
export type GuardSignal = "logprobs" | "segments" | "none";

/** What the second transcriber said about a suspect clip. */
export type SecondOpinion = "speech" | "no_speech" | "error";

export interface GuardVerdict {
  /** True → treat the transcript as empty. */
  noSpeech: boolean;
  /**
   * True → low confidence and nothing firmer: ask a second model before
   * believing it (transcribe.ts does). Never true together with noSpeech
   * straight out of judgeTranscript().
   */
  suspect: boolean;
  reason: GuardReason | null;
  /** Set once a second opinion has been taken. */
  second?: SecondOpinion;
  /** Which confidence signal the provider actually returned. */
  signal: GuardSignal;
  meanLogprob: number | null;
  tokens: number | null;
  /** The LOWEST no_speech_prob across whisper's segments. */
  noSpeechProb: number | null;
  peakDb: number | null;
}

/**
 * TAOS_STT_SILENCE_GUARD=0 turns the whole guard off (the request is then
 * byte-for-byte what it was before this file existed). Anything else is on.
 */
export function silenceGuardEnabled(raw: string | undefined = process.env.TAOS_STT_SILENCE_GUARD): boolean {
  return (raw ?? "").trim() !== "0";
}

/** The threshold, overridable without a deploy of code: TAOS_STT_MIN_MEAN_LOGPROB. */
export function minMeanLogprob(raw: string | undefined = process.env.TAOS_STT_MIN_MEAN_LOGPROB): number {
  const n = Number.parseFloat((raw ?? "").trim());
  return Number.isFinite(n) && n < 0 ? n : MIN_MEAN_LOGPROB;
}

/**
 * What to ask this model for. Only models that were measured: an `include`
 * a model does not support is a 400, and a 400 here is a dead microphone.
 */
export function confidenceRequestFor(model: string): "logprobs" | "verbose_json" | null {
  const m = model.trim().toLowerCase();
  if (/^gpt-4o(?:-mini)?-transcribe(?:$|-\d)/.test(m)) return "logprobs";
  if (/^whisper-/.test(m)) return "verbose_json";
  return null;
}

/**
 * Who to ask about a suspect transcript: a model that has been measured to
 * return nothing for silence, and is not the one that just answered.
 * TAOS_STT_SILENCE_CHECK_MODEL overrides (whisper-1 retires 2027-02-26).
 */
export function secondOpinionModelFor(
  primary: string,
  raw: string | undefined = process.env.TAOS_STT_SILENCE_CHECK_MODEL
): string {
  const override = (raw ?? "").trim();
  if (override) return override;
  return /^gpt-4o-mini-transcribe/i.test(primary.trim()) ? "whisper-1" : "gpt-4o-mini-transcribe";
}

/** Add the confidence request to a transcription form. Returns what was asked for. */
export function applyConfidenceRequest(form: FormData, model: string): "logprobs" | "verbose_json" | null {
  const want = confidenceRequestFor(model);
  if (want === "logprobs") {
    form.append("response_format", "json");
    form.append("include[]", "logprobs");
  } else if (want === "verbose_json") {
    form.append("response_format", "verbose_json");
  }
  return want;
}

function normalizeWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** No letter or digit at all, or nothing but one bracketed stage direction. */
export function hasNoWords(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return /^[[(（【][^\])）】]*[\])）】][\s.。…]*$/u.test(t);
}

/** Is the transcript a run of the prompt we sent, or the model's prompt frame? */
export function isPromptEcho(text: string, prompt: string | undefined): boolean {
  if (/^context:?$/i.test(text.trim())) return true;
  if (!prompt) return false;
  const words = normalizeWords(text);
  if (words.length < ECHO_MIN_WORDS) return false;
  return ` ${normalizeWords(prompt).join(" ")} `.includes(` ${words.join(" ")} `);
}

function meanLogprobOf(payload: Record<string, unknown> | null): { mean: number; tokens: number } | null {
  const list = payload?.logprobs;
  if (!Array.isArray(list) || list.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const item of list) {
    const lp = (item as { logprob?: unknown } | null)?.logprob;
    if (typeof lp === "number" && Number.isFinite(lp)) {
      sum += lp;
      n += 1;
    }
  }
  return n > 0 ? { mean: sum / n, tokens: n } : null;
}

function lowestNoSpeechProb(payload: Record<string, unknown> | null): number | null {
  const list = payload?.segments;
  if (!Array.isArray(list) || list.length === 0) return null;
  let low: number | null = null;
  for (const item of list) {
    const p = (item as { no_speech_prob?: unknown } | null)?.no_speech_prob;
    // One segment without the field means we cannot say "every segment".
    if (typeof p !== "number" || !Number.isFinite(p)) return null;
    if (low === null || p < low) low = p;
  }
  return low;
}

/**
 * Judge one transcription. `payload` is the provider's JSON as it arrived;
 * `prompt` is the prompt that was sent (undefined when none was); `peakDb`
 * is the clip's decoded peak when the server could measure it.
 *
 * With no signal at all the answer is "keep it" — the guard only ever drops
 * a transcript on evidence. A `suspect` verdict is not a drop: the caller
 * takes a second opinion and folds it in with resolveSuspect().
 */
export function judgeTranscript(input: {
  text: string;
  payload: Record<string, unknown> | null;
  prompt?: string;
  peakDb?: number | null;
  minMeanLogprob?: number;
}): GuardVerdict {
  const lp = meanLogprobOf(input.payload);
  const nsp = lowestNoSpeechProb(input.payload);
  const peakDb = typeof input.peakDb === "number" && Number.isFinite(input.peakDb) ? input.peakDb : null;
  const base: GuardVerdict = {
    noSpeech: false,
    suspect: false,
    reason: null,
    signal: lp ? "logprobs" : nsp !== null ? "segments" : "none",
    meanLogprob: lp ? Math.round(lp.mean * 1000) / 1000 : null,
    tokens: lp ? lp.tokens : null,
    noSpeechProb: nsp !== null ? Math.round(nsp * 1000) / 1000 : null,
    peakDb
  };
  const drop = (reason: GuardReason): GuardVerdict => ({ ...base, noSpeech: true, reason });
  // An empty transcript is already "nothing heard"; there is nothing to drop.
  if (!input.text.trim()) return base;
  if (peakDb !== null && peakDb < SILENT_PEAK_DB) return drop("silent_level");
  if (hasNoWords(input.text)) return drop("no_words");
  if (isPromptEcho(input.text, input.prompt)) return drop("prompt_echo");
  if (nsp !== null && nsp >= MIN_NO_SPEECH_PROB) return drop("no_speech_prob");
  if (lp && lp.mean < (input.minMeanLogprob ?? minMeanLogprob())) {
    return { ...base, suspect: true, reason: "low_confidence" };
  }
  return base;
}

/** Fold a second opinion into a suspect verdict: only "speech" keeps the transcript. */
export function resolveSuspect(v: GuardVerdict, second: SecondOpinion): GuardVerdict {
  return { ...v, suspect: false, second, noSpeech: second !== "speech" };
}

/** One log line for a dropped transcript. Numbers only — never the words. */
export function guardLogLine(model: string, text: string, v: GuardVerdict): string {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return (
    `[taos-stt-guard] dropped=1 reason=${v.reason} model=${model} signal=${v.signal}` +
    ` mean_lp=${v.meanLogprob ?? "na"} tokens=${v.tokens ?? "na"} nsp=${v.noSpeechProb ?? "na"}` +
    ` peak_db=${v.peakDb ?? "na"} second=${v.second ?? "na"} words=${words}`
  );
}
