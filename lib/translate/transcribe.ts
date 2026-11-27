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
import {
  applyConfidenceRequest,
  guardLogLine,
  judgeTranscript,
  resolveSuspect,
  secondOpinionModelFor,
  silenceGuardEnabled,
  type GuardVerdict,
  type SecondOpinion
} from "@/lib/translate/silenceGuard";
import { measurePeakDb } from "@/lib/translate/signalLevel";

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
  /**
   * The transcription model for this call. Omit it and every caller gets
   * defaultTranscribeModel(), which is what all of them used before this
   * option existed. Only /api/translate's auto path passes one (see
   * autoTranscribeModel()).
   */
  model?: string;
  /**
   * The API's language hint (ISO-639-1, "es"). Legacy models receive singular
   * `language`; gpt-transcribe successors receive plural `languages[]`. Only
   * the short-transcript retry and /review's Redo pass it
   * (lib/translate/shortTranscript.ts); every first transcription is sent
   * exactly as before. It exists because whisper-1
   * reads `prompt` as sample text to continue, not as instructions — an
   * English prompt that SAYS "Spoken Spanish" pulls whisper-1 toward English
   * output (measured on the 11/5 clip: 48 English words for a minute of
   * Spanish). The gpt-4o transcribers honour the field too.
   */
  languageCode?: string;
  /**
   * Send NO `prompt` at all. Set by the retry for the whisper family only
   * (lib/translate/shortTranscript.ts retryTranscribeOptions): measured on the
   * 11/5 clip, whisper-1 with `language=es` and no prompt returned 109–123
   * Spanish words twice running; with the English instruction prompt beside
   * it, 32 and 81. Never set on a first transcription.
   */
  omitPrompt?: boolean;
  /**
   * Internal to the silence guard: `false` on the second-opinion call itself,
   * so a suspect answer there is taken as "it heard something" instead of
   * asking a third model. Callers never set it.
   */
  silenceSecondOpinion?: boolean;
}

/** The model every surface's mic uses: OPENAI_TRANSCRIBE_MODEL, else gpt-4o-transcribe. */
export function defaultTranscribeModel(): string {
  return process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-transcribe";
}

/**
 * The model for home's Auto-detect turns only. 2026-10-26 (PR #108's live
 * check): gpt-4o-transcribe collapses a two-language clip into ONE language,
 * so a mixed turn never reaches the segments code. gpt-4o-mini-transcribe and
 * whisper-1 keep both halves. OPENAI_AUTO_TRANSCRIBE_MODEL lets the auto path
 * switch without moving /fast, /try, Tabletop or any manual-direction turn.
 * Unset, it is exactly defaultTranscribeModel().
 */
export function autoTranscribeModel(): string {
  return process.env.OPENAI_AUTO_TRANSCRIBE_MODEL?.trim() || defaultTranscribeModel();
}

/**
 * The STT model transcribeAudio() calls when no `model` is passed. Kept as a
 * name for callers that log it; it IS defaultTranscribeModel() — one default.
 */
export function getTranscribeModel(): string {
  return defaultTranscribeModel();
}

/** New transcription models use plural language hints, never `language`. */
export function usesPluralLanguageHints(model: string): boolean {
  return /^(?:gpt-transcribe|gpt-live-transcribe)(?:$|-)/i.test(model.trim());
}

/**
 * How long a finished transcription waits for the level probe that ran beside
 * it. The probe is nearly always back first (~40 ms against the provider's
 * ~600); this only bounds the case where it is not.
 */
export const LEVEL_WAIT_MS = 150;

/** The second opinion on a suspect transcript never gets longer than this. */
export const SECOND_OPINION_TIMEOUT_MS = 15000;

/**
 * Does a second transcriber hear anything in this clip? Same audio, same
 * language hints, a different model (silenceGuard.ts secondOpinionModelFor).
 * Its own structural rules and no-speech flag apply; its confidence does not
 * get a third opinion. A failure is "error", which the guard treats as no.
 */
async function secondOpinion(
  apiKey: string,
  file: File,
  primaryModel: string,
  options: TranscribeOptions
): Promise<SecondOpinion> {
  const model = secondOpinionModelFor(primaryModel);
  const whisper = /^whisper/i.test(model);
  try {
    const heard = await transcribeAudioDetailed(apiKey, file, {
      sourceLabel: options.sourceLabel,
      // whisper reads `prompt` as text to continue (see omitPrompt above).
      extraHint: whisper ? undefined : options.extraHint,
      languageCode: options.languageCode,
      omitPrompt: whisper || undefined,
      model,
      timeoutMs: Math.min(options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS, SECOND_OPINION_TIMEOUT_MS),
      silenceSecondOpinion: false
    });
    return heard.text ? "speech" : "no_speech";
  } catch {
    return "error";
  }
}

export interface TranscribeResult {
  /** The transcript; "" when nothing was heard OR the silence guard dropped it. */
  text: string;
  /** The silence guard's verdict; null when the guard is off or never ran. */
  guard: GuardVerdict | null;
}

/**
 * Transcribe one audio file.
 *
 * Returns `""` — not an error — when the audio held no usable speech, so the
 * caller can answer with its own bilingual "try again" rather than surfacing
 * provider JSON to somebody who just tapped a button too fast.
 *
 * "No usable speech" includes a transcript the silence guard does not believe
 * (lib/translate/silenceGuard.ts): the transcriber writes a sentence for
 * silence, and that sentence must never leave this function. Every caller
 * gets that for free — which is the point of there being one transcriber.
 */
export async function transcribeAudio(
  apiKey: string,
  file: File,
  options: TranscribeOptions = {}
): Promise<string> {
  return (await transcribeAudioDetailed(apiKey, file, options)).text;
}

/** transcribeAudio(), plus the silence guard's verdict for callers that log it. */
export async function transcribeAudioDetailed(
  apiKey: string,
  file: File,
  options: TranscribeOptions = {}
): Promise<TranscribeResult> {
  const { sourceLabel, extraHint, timeoutMs = TRANSCRIBE_TIMEOUT_MS } = options;
  const model = options.model?.trim() || defaultTranscribeModel();
  const form = new FormData();
  form.append("file", file, file.name || "audio.webm");
  form.append("model", model);
  if (options.languageCode) {
    if (usesPluralLanguageHints(model)) form.append("languages[]", options.languageCode);
    else form.append("language", options.languageCode);
  }
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
  const prompt = options.omitPrompt ? undefined : hint ? `${base} ${hint}` : base;
  if (prompt !== undefined) form.append("prompt", prompt);

  // The silence guard: ask the model for its own confidence in this same
  // request, and measure the clip's level beside it (not in front of it — a
  // turn with speech in it must not wait on the check).
  const guardOn = silenceGuardEnabled();
  if (guardOn) applyConfidenceRequest(form, model);
  const level: Promise<number | null> = guardOn ? measurePeakDb(file).catch(() => null) : Promise.resolve(null);

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
      return { text: "", guard: null };
    }
    const detail =
      payload && typeof payload === "object" ? JSON.stringify(payload) : `HTTP ${res.status}`;
    // upstreamStatus rides along for the route's timing line; the message
    // (which callers surface as `details`) is unchanged.
    throw Object.assign(new Error(`Transcription failed: ${detail}`), {
      upstreamStatus: res.status
    });
  }
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!guardOn || !text) return { text, guard: null };
  const peakDb = await Promise.race([
    level,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), LEVEL_WAIT_MS))
  ]);
  let guard = judgeTranscript({ text, payload, prompt, peakDb });
  // Low confidence alone is a suspicion (one token's logprob is as much
  // about spelling as about sound). Ask a second model; drop the transcript
  // only if it hears nothing either. Costs ~400 ms, on suspect turns only.
  if (guard.suspect && options.silenceSecondOpinion !== false) {
    guard = resolveSuspect(guard, await secondOpinion(apiKey, file, model, options));
  }
  if (guard.noSpeech) {
    // Numbers only: what was dropped is, by definition, not what anybody said,
    // but it is still not ours to print.
    console.log(guardLogLine(model, text, guard));
    return { text: "", guard };
  }
  return { text, guard };
}
