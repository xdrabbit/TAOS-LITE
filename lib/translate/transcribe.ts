// Speech → text. The one transcriber.
//
// This is app/api/translate/route.ts's `transcribe()`, lifted out unchanged so
// a second caller could have it rather than copy it. /fast's mic
// (app/api/fast/listen/route.ts) is that second caller, and the reason the
// lift was worth doing: the fences below are not incidental. STT_NO_GUESS_RULE
// is Liz's 7/27 finding (a signal dip turned "montar bicicleta" into "montar
// un caballo"), the Cantonese hint is the difference between Cantonese and
// Standard Written Chinese, and isUnusableAudioError is what makes a rapid
// double-tap a gentle retry instead of raw provider JSON. A fourth hand-rolled
// copy of this call would have shipped with none of them.
//
// It is deliberately transcript-ONLY: no translation, no tone, no opinion
// about what the words are for. /api/translate paraphrases what comes back;
// /api/fast/listen puts it in a text box for somebody to edit. Same audio,
// same rules, different next step.
import {
  CANTONESE_STT_HINT,
  isUnusableAudioError,
  STT_NO_GUESS_RULE
} from "@/lib/translate/prompts";

/**
 * Production 2026-07-19: an OpenAI call stalled and the function hung its full
 * `maxDuration` until Vercel killed it — the phone's fetch died with Safari's
 * opaque "Load failed". Every upstream call is capped well under the route's
 * ceiling so a stall becomes a fast, retryable JSON error and not a dead
 * socket. This default is /api/translate's: long, because a spoken turn there
 * can re-upload five minutes of audio. Callers that only ever send a phrase
 * pass something shorter.
 */
export const TRANSCRIBE_TIMEOUT_MS = 120000;

export interface TranscribeOptions {
  /**
   * The language the audio is expected to be in, as a label ("Spanish").
   * Sharpens accuracy — omit it for auto-detect so the model is free to
   * recognize whichever language was actually spoken.
   */
  sourceLabel?: string;
  /**
   * An extra prompt fragment. Overrides the Cantonese hint that `sourceLabel`
   * would otherwise imply, which is how an auto-detect caller passes it: the
   * hint is needed whenever Cantonese is POSSIBLE, and in auto mode no label
   * says so.
   */
  extraHint?: string;
  /** Upstream timeout for this caller. Defaults to TRANSCRIBE_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Transcribe one audio file.
 *
 * Returns `""` — not an error — when the audio held no usable speech, so the
 * caller can answer with its own bilingual "try again" rather than surfacing
 * provider JSON to somebody who just tapped a button too fast.
 */
export async function transcribeAudio(
  apiKey: string,
  file: File,
  options: TranscribeOptions = {}
): Promise<string> {
  const { sourceLabel, extraHint, timeoutMs = TRANSCRIBE_TIMEOUT_MS } = options;
  const model = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-transcribe";
  const form = new FormData();
  form.append("file", file, file.name || "audio.webm");
  form.append("model", model);
  // A language hint sharpens accuracy; omit it in auto-detect mode so the model
  // is free to recognize whichever language was spoken. Cantonese always gets
  // the colloquial-written-form hint or the transcript comes back as Standard
  // Written Chinese and reads as Mandarin. STT_NO_GUESS_RULE applies to every
  // turn: audio dropouts must become gaps, never invented words (Liz, 7/27:
  // "montar bicicleta" with a signal dip came back "montar un caballo").
  const base = sourceLabel
    ? `Spoken ${sourceLabel}. Transcribe verbatim with natural punctuation. ${STT_NO_GUESS_RULE}`
    : `Transcribe verbatim with natural punctuation. ${STT_NO_GUESS_RULE}`;
  const hint = extraHint ?? (sourceLabel === "Cantonese" ? CANTONESE_STT_HINT : "");
  form.append("prompt", hint ? `${base} ${hint}` : base);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs)
  });

  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    // A micro-clip (rapid double-tap) or a mangled upload means "no usable
    // speech", not a server failure — return "" so the caller responds with
    // its gentle bilingual retry message instead of raw provider JSON.
    const err = payload?.error as Record<string, unknown> | undefined;
    const msg = typeof err?.message === "string" ? err.message : "";
    if (isUnusableAudioError(msg)) {
      return "";
    }
    const detail =
      payload && typeof payload === "object" ? JSON.stringify(payload) : `HTTP ${res.status}`;
    throw new Error(`Transcription failed: ${detail}`);
  }
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  return text;
}
