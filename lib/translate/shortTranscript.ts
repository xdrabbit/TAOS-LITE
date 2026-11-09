// A transcript that is implausibly short for its audio — and what to do next.
//
// Production 2026-11-05 ~19:24 MT, home screen, auto mode, in a car: a 69 s
// clip came back from gpt-4o-mini-transcribe as five English words in 2.6 s.
// Tom said a few words in English, Liz then spoke Spanish for a minute, and
// the transcriber — having locked onto the first language it heard — treated
// the rest as silence. The October probe (PR #109) had already seen the
// weakness: noisy or unexpected Spanish in auto mode, which whisper-1 did
// not share. The clip is kept in the review bucket (Tom's turn, 11/5 07:24
// PM, 1:09) and tests/live-fire/short-transcript-retry.measure.ts replays it.
//
// The fix is one bounded retry on the server: when the words-per-second of
// the transcript is far below speech, run the same audio once more through
// the fallback transcriber with the language hint set to the pair's OTHER
// language, and keep whichever transcript says more. Pure here; the route
// does the calling and the logging.
//
// ── The threshold, and why ─────────────────────────────────────────────────
// Measured on the 40 real founder turns kept for review 2026-11-04..05
// (durations decoded with ffmpeg, words counted from the stored transcript):
// conversational speech on this app runs 1.0–2.8 words/s; the slowest
// honest turns — long pauses in a car, a thought started twice — bottom out
// at 0.5–0.7 words/s; the broken turn is 0.10 words/s and the one Taokie
// turn that lost most of its words is 0.27. 0.4 words/s sits between the
// slowest honest turn and the failures with room on both sides. Below 8 s a
// turn is a phrase, where "two words in three seconds" is normal and a retry
// would only add latency; and a turn with NO words already answers 422.
import { getLanguageLabel, isSupportedLanguageCode } from "@/lib/realtime/languages";

export const SHORT_MIN_SECONDS = 8;
export const SHORT_MAX_WORDS_PER_SECOND = 0.4;

/** Whitespace-separated tokens — the same count the review census used. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Bytes per second of audio by container, for when the phone did not say how
 * long it recorded. Opus-in-WebM (Chrome, Android) measured 6.2–6.6 kB/s on
 * 36 of 40 real clips; AAC-in-MP4 (iOS Safari) is assumed at 8 kB/s; PCM WAV
 * at 16 kHz mono is exactly 32 kB/s. A wrong guess here only moves a turn
 * across the 8 s floor — never past the words/s rule.
 */
export function bytesPerSecondFor(mime: string): number {
  const m = (mime || "").toLowerCase();
  if (m.includes("wav") || m.includes("pcm")) return 32000;
  if (m.includes("mp4") || m.includes("aac") || m.includes("m4a") || m.includes("mpeg")) return 8000;
  return 6400;
}

/**
 * How long the clip is, in seconds. The phone's own stopwatch (`rec_ms`)
 * wins; a decoded duration (normalize, lib/translate/normalize.ts) wins over
 * that; the bytes estimate is the last resort.
 */
export function estimateClipSeconds(input: {
  recMs?: number | null;
  decodedSeconds?: number | null;
  bytes: number;
  mime: string;
}): number {
  if (typeof input.decodedSeconds === "number" && Number.isFinite(input.decodedSeconds) && input.decodedSeconds > 0) {
    return input.decodedSeconds;
  }
  if (typeof input.recMs === "number" && Number.isFinite(input.recMs) && input.recMs > 0) {
    return input.recMs / 1000;
  }
  return input.bytes / bytesPerSecondFor(input.mime);
}

export interface ShortVerdict {
  short: boolean;
  words: number;
  seconds: number;
  /** Words per second, rounded to 2 places; 0 for an empty transcript. */
  wps: number;
}

/** Is this transcript too short for this much audio? */
export function shortTranscriptVerdict(text: string, seconds: number): ShortVerdict {
  const words = wordCount(text);
  const wps = seconds > 0 ? Math.round((words / seconds) * 100) / 100 : 0;
  const short = words > 0 && seconds >= SHORT_MIN_SECONDS && wps < SHORT_MAX_WORDS_PER_SECOND;
  return { short, words, seconds, wps };
}

/**
 * The transcriber the retry runs on. whisper-1 by default: the October probe
 * found it does not share gpt-4o-mini-transcribe's habit of dropping the
 * second language, and it is a different model family, so a retry is a
 * second opinion rather than the same mistake twice. OpenAI has announced
 * whisper-1's retirement for 2027-02-26 and names `gpt-transcribe` as its
 * successor — this is a knob so the day it goes, one env var moves it.
 */
export function fallbackTranscribeModel(): string {
  return process.env.TAOS_TRANSCRIBE_FALLBACK_MODEL?.trim() || "whisper-1";
}

/**
 * Which of the pair's two languages a short transcript is in, by the same
 * accent-and-stopword test the review export uses (lib/review/clipSet.ts),
 * so the retry can be hinted toward the OTHER one. Only decides between
 * English and Spanish — for any other pair the answer is null and the retry
 * runs with no hint, which is still a different model on the same audio.
 */
export function guessPairLanguage(text: string, pairA: string, pairB: string): string | null {
  const pair = [pairA, pairB];
  if (!pair.includes("en") || !pair.includes("es")) return null;
  if (/[ñ¿¡áéíóú]/i.test(text)) return "es";
  return /\b(que|el|la|los|las|de|y|es|por|para|con|una?|yo|tu|mi)\b/i.test(text) ? "es" : "en";
}

/** The pair language the transcript is NOT in, or null when that cannot be told. */
export function otherPairLanguage(text: string, pairA: string, pairB: string): string | null {
  const heard = guessPairLanguage(text, pairA, pairB);
  if (!heard) return null;
  return heard === pairA ? pairB : pairA;
}

/**
 * The retry must say at least this many times as many words to replace the
 * first transcript. A real miss is not close: the 11/5 clip went from 7
 * words to 100+ (14×). A false trigger — a slow speaker whose short
 * transcript was in fact complete — hinted toward the wrong language makes
 * whisper-1 invent a transcript in that language (measured: 35–39 Spanish
 * words for 55 s of English that the first pass had read as 22–25), and
 * that invention runs 1.5–1.8× the honest count. 2× keeps it out.
 */
export const RETRY_MIN_WORD_GAIN = 2;

/** Keep the retry only when it clearly says more; otherwise the first transcript. */
export function pickLongerTranscript(
  first: string,
  second: string,
  minGain: number = RETRY_MIN_WORD_GAIN
): { text: string; picked: "first" | "second" } {
  const a = wordCount(first);
  const b = wordCount(second);
  return b > 0 && b >= a * minGain && b > a ? { text: second, picked: "second" } : { text: first, picked: "first" };
}

/**
 * How the retry calls the transcriber. The hint goes in the API's own
 * language-hint field (singular for legacy models, plural for successors) and,
 * for non-Whisper models, the usual "Spoken X" prompt too. The whisper family
 * gets NO prompt: it reads `prompt` as text to
 * continue, and the English instruction pulled it toward English on a
 * Spanish clip (lib/translate/transcribe.ts, omitPrompt).
 */
export function retryTranscribeOptions(
  model: string,
  hint: { code: string; label: string } | null,
  extraHint?: string
): { model: string; sourceLabel?: string; languageCode?: string; omitPrompt?: boolean; extraHint?: string } {
  const whisper = /^whisper/i.test(model.trim());
  return {
    model,
    sourceLabel: hint?.label,
    languageCode: hint?.code,
    omitPrompt: whisper || undefined,
    extraHint: whisper ? undefined : extraHint
  };
}

/**
 * The retry hint for a KEPT turn (Redo · Rehacer, app/api/review/redo): an
 * auto turn is hinted toward the OTHER language of the pair the first
 * transcriber decided on — what it locked onto is what it heard first — and
 * a manual turn keeps its known language. Null when the code is unknown.
 */
export function redoHintFor(turn: { mode: string; source_lang: string; target_lang: string }): { code: string; label: string } | null {
  const code = turn.mode === "auto" ? turn.target_lang : turn.source_lang;
  if (!isSupportedLanguageCode(code)) return null;
  return { code, label: getLanguageLabel(code) };
}
