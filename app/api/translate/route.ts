import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { keepTurnForReview, speakerKeepsAudio, type Speaker } from "@/lib/review/capture";
import {
  getLanguageLabel,
  isSupportedLanguageCode,
  type SupportedLanguageCode
} from "@/lib/realtime/languages";
import { CANTONESE_STT_HINT, parseTone } from "@/lib/translate/prompts";
import { parseContextField } from "@/lib/translate/context";
import {
  autoTranscribeModel,
  defaultTranscribeModel,
  transcribeAudio
} from "@/lib/translate/transcribe";
import { getTranslateModel, paraphrase, paraphraseAuto } from "@/lib/translate/paraphrase";
import { normalizeForStt, sttNormalizeEnabled } from "@/lib/translate/normalize";
import {
  estimateClipSeconds,
  fallbackTranscribeModel,
  otherPairLanguage,
  pickLongerTranscript,
  retryTranscribeOptions,
  shortTranscriptVerdict,
  wordCount
} from "@/lib/translate/shortTranscript";
import { guardSpend } from "@/lib/spendGuard";
import { topLevelFromSegments } from "@/lib/translate/segments";

export const runtime = "nodejs";
// 300s is the max on Vercel Pro. The client per-turn cap (MAX_TURN_DURATION_MS
// in TranslatorShell) must stay <= this, or a long turn can't be transcribed +
// paraphrased before the function is killed and the turn fails silently.
export const maxDuration = 300;

// Production 2026-07-19: an OpenAI call stalled and this function hung the
// full 300s until Vercel killed it — the phone's fetch died with Safari's
// opaque "Load failed". Cap each upstream call well under maxDuration so a
// stall becomes a fast, retryable JSON error instead of a dead socket.
// Transcription gets longer (it re-uploads up to 5 minutes of audio) and its
// cap now lives with the transcriber, in lib/translate/transcribe.ts; the
// chat completion's cap lives with it in lib/translate/paraphrase.ts.

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

// ── [taos-translate-timing] ────────────────────────────────────────────────
// One line per request, success or error, saying where the seconds went:
// guardSpend, transcription, the chat completion, and the whole request.
// Diagnostic only (10/27: 10-15s from stop-recording to voice, with TTS
// measured fast). NEVER put transcript or translation text, an email, or a
// raw user agent in it — lengths and codes only.
interface TranslateTiming {
  mode: "auto" | "manual" | "?";
  src: string;
  tgt: string;
  audioBytes: number | "?";
  audioMime: string;
  transcribeMs: number | "?";
  translateMs: number | "?";
  guardMs: number | "?";
  /** Reading + parsing the multipart body — the server's view of the upload. */
  formMs: number | "?";
  srcChars: number | "?";
  outChars: number | "?";
  err: string;
  /** The STT model this request used — the auto path's may differ. "?" before transcription. */
  transcribeModel: string;
  /** The stage in flight, so a thrown error can be named (and timed) after it. */
  stage: "guard" | "form" | "transcribe" | "translate";
  stageStarted: number;
  // ── Short-transcript retry + quiet normalize (2026-11-05) ────────────────
  /** The phone's own stopwatch for the recording, ms; "?" when it sent none. */
  recMs: number | "?";
  /** Words/s of the FIRST transcript against the clip length; "?" before transcription. */
  wps: number | "?";
  /** 1 when the fallback transcriber ran, else 0. */
  retryStt: 0 | 1;
  retryReason: "short" | "?";
  retryModel: string;
  /** The language the retry was hinted toward; "none" for no hint. */
  retryHint: string;
  /** Word counts of the first and the retry transcript. */
  stt1Words: number | "?";
  stt2Words: number | "?";
  /** Which transcript the turn went on with. */
  sttPicked: "first" | "retry" | "?";
  /** Wall time of the retry transcription alone (transcribe_ms includes it). */
  retryMs: number | "?";
  /** Gain applied before transcription, dB; 0 = loud enough; "na" = no ffmpeg; "?" = off. */
  normGainDb: number | "na" | "?";
  normMs: number | "?";
}

// First request on this function instance — a cold start's tax lands here.
let instanceWarm = false;

function since(t0: number): number {
  return Math.round(performance.now() - t0);
}

/** `transcribe_timeout`, `translate_422`, … — a code, never a message. */
function errorCode(stage: TranslateTiming["stage"], e: unknown): string {
  if (isTimeout(e)) return `${stage}_timeout`;
  const status = (e as { upstreamStatus?: unknown } | null)?.upstreamStatus;
  if (typeof status === "number") return `${stage}_${status}`;
  return `${stage}_failed`;
}

function attemptFlag(req: NextRequest): "0" | "1" | "?" {
  const n = Number.parseInt(req.headers.get("x-taos-attempt") ?? "", 10);
  if (!Number.isFinite(n)) return "?";
  return n > 1 ? "1" : "0";
}

/** A non-negative integer form field, or null. */
function intField(form: FormData, name: string): number | null {
  const raw = form.get(name);
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// parseTone / buildInstructions / isUnusableAudioError live in
// lib/translate/prompts.ts so their behavior is unit-tested, the transcriber
// in lib/translate/transcribe.ts (shared with /fast's mic), and the two chat
// completions in lib/translate/paraphrase.ts (shared with /review's Redo).

/**
 * The longest recording an anonymous /try caller may upload.
 *
 * Transcription is billed per second of audio, so this is the same kind of
 * fence as ANON_MAX_CHARS in /api/tts: not a quality limit, a bill limit.
 * Comfortably above a real /try turn (a sentence or two) and far below the
 * 5-minute cap a signed-in phone is allowed.
 */
const ANON_MAX_AUDIO_BYTES = 4 * 1024 * 1024;

// ── Transcribe, with one bounded retry ─────────────────────────────────────
// lib/translate/shortTranscript.ts has the why and the numbers. The first
// transcription runs exactly as before; if its words-per-second says the
// transcriber gave up on most of the clip, the SAME audio goes once through
// the fallback transcriber — hinted toward the pair's other language in auto
// mode, the known language in manual — and the turn goes on with the retry
// only when it clearly says more. One retry, ever; transcribe_ms on the
// timing line covers both.
async function retryShort(
  apiKey: string,
  audio: File,
  t: TranslateTiming,
  first: string,
  hint: { code: string; label: string } | null,
  extraHint: string | undefined
): Promise<string> {
  t.retryStt = 1;
  t.retryReason = "short";
  const model = fallbackTranscribeModel();
  t.retryModel = model;
  t.retryHint = hint?.code ?? "none";
  const t0 = performance.now();
  let again = "";
  try {
    again = await transcribeAudio(apiKey, audio, retryTranscribeOptions(model, hint, extraHint));
  } catch {
    // The retry is a bonus, not a dependency: a failed second call keeps the
    // first transcript and says so with stt2_words=? on the timing line.
    again = "";
  }
  t.retryMs = since(t0);
  t.stt2Words = again ? wordCount(again) : "?";
  const picked = pickLongerTranscript(first, again);
  t.sttPicked = picked.picked === "second" ? "retry" : "first";
  return picked.text;
}

// ── Founder review (2026-11-04) ────────────────────────────────────────────
// A founder who turned on "Keep my audio for review" gets this turn's clip,
// transcript and translation copied into the review store for 14 days
// (lib/review/capture.ts). Off the response path (waitUntil), only after the
// turn succeeded, and only ever for the SPEAKER's own setting — an
// anonymous or non-founder caller never reaches the database for this.
// The home-history row stays exactly what it was: text, no audio.
//
// The row id is minted HERE and returned to the phone as `reviewId`, so the
// result card can offer Redo · Rehacer on a turn whose copy is still landing.
function keepForReview(input: {
  id: string;
  user: Speaker | null;
  keep: boolean;
  audio: File;
  mode: "manual" | "auto";
  sourceLang: string;
  targetLang: string;
  original: string;
  translation: string;
  segments: unknown | null;
  t: TranslateTiming;
  startedAt: number;
}): string | null {
  if (!input.keep || !input.user) return null;
  const { audio, t } = input;
  waitUntil(
    audio
      .arrayBuffer()
      .then((bytes) =>
        keepTurnForReview({
          id: input.id,
          user: input.user as Speaker,
          surface: "home",
          mode: input.mode,
          audio: bytes,
          audioMime: audio.type || "audio/webm",
          sourceLang: input.sourceLang,
          targetLang: input.targetLang,
          originalText: input.original,
          translationText: input.translation,
          segments: input.segments,
          recMs: t.recMs === "?" ? null : t.recMs,
          transcribeModel: t.transcribeModel === "?" ? null : t.transcribeModel,
          translateModel: getTranslateModel(),
          timings: {
            transcribe_ms: typeof t.transcribeMs === "number" ? t.transcribeMs : undefined,
            translate_ms: typeof t.translateMs === "number" ? t.translateMs : undefined,
            total_ms: Date.now() - input.startedAt
          }
        })
      )
      .catch(() => null)
  );
  return input.id;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = performance.now();
  const cold = instanceWarm ? 0 : 1;
  instanceWarm = true;
  const t: TranslateTiming = {
    mode: "?",
    src: "?",
    tgt: "?",
    audioBytes: "?",
    audioMime: "?",
    transcribeMs: "?",
    translateMs: "?",
    guardMs: "?",
    formMs: "?",
    srcChars: "?",
    outChars: "?",
    err: "?",
    transcribeModel: "?",
    stage: "guard",
    stageStarted: started,
    recMs: "?",
    wps: "?",
    retryStt: 0,
    retryReason: "?",
    retryModel: "?",
    retryHint: "?",
    stt1Words: "?",
    stt2Words: "?",
    sttPicked: "?",
    retryMs: "?",
    normGainDb: "?",
    normMs: "?"
  };
  let res: NextResponse | undefined;
  try {
    res = await handle(req, t);
    return res;
  } finally {
    const http = res?.status ?? 500;
    const ok = http >= 200 && http < 300;
    console.log(
      `[taos-translate-timing] status=${ok ? "ok" : "error"} http=${http} mode=${t.mode}` +
        ` src=${t.src} tgt=${t.tgt} audio_bytes=${t.audioBytes} audio_mime=${t.audioMime}` +
        ` transcribe_ms=${t.transcribeMs} transcribe_model=${t.transcribeModel}` +
        ` translate_ms=${t.translateMs} translate_model=${getTranslateModel()}` +
        ` guard_ms=${t.guardMs} form_ms=${t.formMs} total_ms=${since(started)} src_chars=${t.srcChars}` +
        ` out_chars=${t.outChars} cold=${cold} retry=${attemptFlag(req)}` +
        ` err=${ok ? "?" : t.err === "?" ? "unhandled" : t.err}` +
        ` rec_ms=${t.recMs} wps=${t.wps} retry_stt=${t.retryStt} retry_reason=${t.retryReason}` +
        ` retry_model=${t.retryModel} retry_hint=${t.retryHint} stt1_words=${t.stt1Words}` +
        ` stt2_words=${t.stt2Words} stt_picked=${t.sttPicked} retry_ms=${t.retryMs}` +
        ` norm_gain_db=${t.normGainDb} norm_ms=${t.normMs}`
    );
  }
}

async function handle(req: NextRequest, t: TranslateTiming): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    // Before the key is read and long before OpenAI is called: this route
    // spends on transcription AND a chat completion per turn, and until 8/19
    // it asked nobody who they were. `allowAnonymous` is the /try funnel
    // (components/AtomShell.tsx) — see lib/spendGuard.ts.
    t.stageStarted = performance.now();
    const guard = await guardSpend(req, { allowAnonymous: true });
    t.guardMs = since(t.stageStarted);
    if (!guard.ok) {
      t.err = "guard_blocked";
      return guard.response;
    }
    // Asked now, awaited after the turn: one profile read for a founder,
    // overlapped with the transcription; nothing at all for anyone else.
    const keepPromise = speakerKeepsAudio(guard.user).catch(() => false);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      t.err = "missing_api_key";
      return NextResponse.json(
        { error: "Server misconfiguration: missing OPENAI_API_KEY." },
        { status: 500 }
      );
    }

    t.stage = "form";
    t.stageStarted = performance.now();
    const form = await req.formData();
    t.formMs = since(t.stageStarted);
    const audio = form.get("audio");
    const sourceLanguage = String(form.get("sourceLanguage") ?? "");
    const targetLanguage = String(form.get("targetLanguage") ?? "");
    const tone = parseTone(form.get("tone"));
    // The last few turns of this conversation, for disambiguation only
    // (lib/translate/context.ts). Null on anything malformed — the turn then
    // translates exactly as it did before context existed. Request-only:
    // never logged, never saved, never echoed back.
    const context = parseContextField(form.get("context"));
    // How long the phone recorded, by its own clock. The short-transcript
    // check needs the clip's length, and a MediaRecorder WebM does not carry
    // one; absent, the length is estimated from the bytes.
    const recMs = intField(form, "rec_ms");
    t.recMs = recMs ?? "?";
    t.mode = sourceLanguage === "auto" ? "auto" : "manual";
    if (sourceLanguage === "auto") t.src = "auto";
    else if (isSupportedLanguageCode(sourceLanguage)) t.src = sourceLanguage;
    t.tgt = isSupportedLanguageCode(targetLanguage) ? targetLanguage : "?";
    if (audio instanceof File) {
      t.audioBytes = audio.size;
      t.audioMime = audio.type.replace(/\s+/g, "") || "?";
    }

    if (!(audio instanceof File) || audio.size === 0) {
      t.err = "no_audio";
      return NextResponse.json({ error: "An audio recording is required." }, { status: 400 });
    }

    if (guard.anonymous && audio.size > ANON_MAX_AUDIO_BYTES) {
      t.err = "anon_audio_too_large";
      return NextResponse.json(
        { error: "That recording is too long for the free trial. Please sign in." },
        { status: 413 }
      );
    }

    // Quiet normalize (lib/translate/normalize.ts): founders by default,
    // TAOS_STT_NORMALIZE=1/0 for everyone/nobody. The transcriber gets the
    // normalized WAV; the review copy keeps the ORIGINAL clip, so a Redo and
    // the probe see what the phone sent. Also the only honest clip length.
    let sttAudio: File = audio;
    let decodedSeconds: number | null = null;
    if (sttNormalizeEnabled(guard.user?.email)) {
      const norm = await normalizeForStt(audio);
      if (norm) {
        sttAudio = norm.file;
        decodedSeconds = norm.seconds;
        t.normGainDb = norm.gainDb;
        t.normMs = norm.ms;
      } else {
        t.normGainDb = "na";
      }
    }
    const clipSeconds = estimateClipSeconds({ recMs, decodedSeconds, bytes: audio.size, mime: audio.type });

    // Auto-detect direction: transcribe with no language hint, then let the
    // model decide which of the conversation pair's two languages it heard
    // and translate to the other. The pair comes from the client's language
    // picker (pairA/pairB); absent fields keep the historic en/es behavior.
    if (sourceLanguage === "auto") {
      const pairARaw = String(form.get("pairA") ?? "en");
      const pairBRaw = String(form.get("pairB") ?? "es");
      const pairA: SupportedLanguageCode = isSupportedLanguageCode(pairARaw) ? pairARaw : "en";
      let pairB: SupportedLanguageCode = isSupportedLanguageCode(pairBRaw) ? pairBRaw : "es";
      if (pairB === pairA) pairB = pairA === "en" ? "es" : "en";

      // In auto mode with Cantonese in the pair, the transcriber still needs
      // the colloquial-written-form hint — otherwise zh/yue speech both come
      // back as Standard Written Chinese and detection can't tell them apart.
      const autoHint =
        pairA === "yue" || pairB === "yue" ? CANTONESE_STT_HINT : undefined;
      // Auto turns may run on their own transcriber (OPENAI_AUTO_TRANSCRIBE_MODEL):
      // production's default drops one language from a mixed clip.
      const transcriber = autoTranscribeModel();
      t.transcribeModel = transcriber;
      t.stage = "transcribe";
      t.stageStarted = performance.now();
      // The retry's hint is decided from the FIRST transcript: the language
      // it locked onto is the one it heard first, so the retry is hinted
      // toward the pair's other side (null when that cannot be told).
      const first = await transcribeAudio(apiKey, sttAudio, { extraHint: autoHint, model: transcriber });
      const verdict = shortTranscriptVerdict(first, clipSeconds);
      t.stt1Words = verdict.words;
      t.wps = verdict.wps;
      let original = first;
      if (verdict.short) {
        const other = otherPairLanguage(first, pairA, pairB);
        const hint = other && isSupportedLanguageCode(other) ? { code: other, label: getLanguageLabel(other) } : null;
        original = await retryShort(apiKey, sttAudio, t, first, hint, autoHint);
      }
      t.transcribeMs = since(t.stageStarted);
      t.srcChars = original.length;
      if (!original) {
        t.err = "nothing_heard";
        return NextResponse.json(
          { error: "Nothing was heard — try again. · No se escuchó nada — intenta de nuevo." },
          { status: 422 }
        );
      }
      t.stage = "translate";
      t.stageStarted = performance.now();
      const segments = await paraphraseAuto(
        apiKey,
        original,
        tone,
        { code: pairA, label: getLanguageLabel(pairA) },
        { code: pairB, label: getLanguageLabel(pairB) },
        context
      );
      t.translateMs = since(t.stageStarted);
      const top = topLevelFromSegments(segments);
      t.outChars = top.translation.length;
      // In auto mode src stays "auto" (what was asked); tgt is the resolved
      // side — the first segment's, same as the response's top level.
      t.tgt = top.targetLanguage;
      // Body-less on purpose: counts and codes, never the transcript, the
      // email, or the user agent. ctx is how many earlier turns came along —
      // a number, never their words.
      const ctxTurns = context?.length ?? 0;
      console.log(
        `[taos-translate] auto=1 segments=${segments.length} detected=${segments
          .map((seg) => seg.sourceLanguage)
          .join(",")} src_chars=${original.length} ctx=${ctxTurns} transcriber=${transcriber} ms=${
          Date.now() - startedAt
        }`
      );
      const reviewId = keepForReview({
        id: crypto.randomUUID(),
        user: guard.user,
        keep: await keepPromise,
        audio,
        mode: "auto",
        sourceLang: top.sourceLanguage,
        targetLang: top.targetLanguage,
        original,
        translation: top.translation,
        segments: segments.length > 1 ? segments : null,
        t,
        startedAt
      });
      // One segment is today's response exactly. Several keep the same
      // top-level fields (joined, direction from the first) so any reader of
      // them still works, plus the segments themselves.
      return NextResponse.json({
        ...top,
        tone,
        autoDetected: true,
        ...(segments.length > 1 ? { segments } : {}),
        ...(reviewId ? { reviewId } : {})
      });
    }

    if (!isSupportedLanguageCode(sourceLanguage) || !isSupportedLanguageCode(targetLanguage)) {
      t.err = "unsupported_pair";
      return NextResponse.json({ error: "Unsupported language pair." }, { status: 400 });
    }
    if (sourceLanguage === targetLanguage) {
      t.err = "same_language";
      return NextResponse.json(
        { error: "Source and target languages must differ." },
        { status: 400 }
      );
    }

    const sourceLabel = getLanguageLabel(sourceLanguage);
    const targetLabel = getLanguageLabel(targetLanguage);

    // No model passed, so transcribeAudio() uses this one.
    t.transcribeModel = defaultTranscribeModel();
    t.stage = "transcribe";
    t.stageStarted = performance.now();
    // Manual direction: the language is known, so the retry keeps the same
    // hint and only changes the model.
    const first = await transcribeAudio(apiKey, sttAudio, { sourceLabel });
    const verdict = shortTranscriptVerdict(first, clipSeconds);
    t.stt1Words = verdict.words;
    t.wps = verdict.wps;
    const original = verdict.short
      ? await retryShort(apiKey, sttAudio, t, first, { code: sourceLanguage, label: sourceLabel }, undefined)
      : first;
    t.transcribeMs = since(t.stageStarted);
    t.srcChars = original.length;
    if (!original) {
      t.err = "nothing_heard";
      return NextResponse.json(
        { error: "Nothing was heard — try again. · No se escuchó nada — intenta de nuevo." },
        { status: 422 }
      );
    }

    t.stage = "translate";
    t.stageStarted = performance.now();
    const translation = await paraphrase(
      apiKey,
      original,
      sourceLabel,
      targetLabel,
      tone,
      context
    );
    t.translateMs = since(t.stageStarted);
    t.outChars = translation.length;

    const reviewId = keepForReview({
      id: crypto.randomUUID(),
      user: guard.user,
      keep: await keepPromise,
      audio,
      mode: "manual",
      sourceLang: sourceLanguage,
      targetLang: targetLanguage,
      original,
      translation,
      segments: null,
      t,
      startedAt
    });

    return NextResponse.json({
      original,
      translation,
      sourceLanguage,
      targetLanguage,
      tone,
      ...(reviewId ? { reviewId } : {})
    });
  } catch (error) {
    t.err = errorCode(t.stage, error);
    if (t.stage === "guard") t.guardMs = since(t.stageStarted);
    if (t.stage === "form") t.formMs = since(t.stageStarted);
    if (t.stage === "transcribe") t.transcribeMs = since(t.stageStarted);
    if (t.stage === "translate") t.translateMs = since(t.stageStarted);
    if (isTimeout(error)) {
      return NextResponse.json(
        { error: "The translation service took too long. Please try again." },
        { status: 504 }
      );
    }
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: "Translation pipeline failed.", details: message }, {
      status: 502
    });
  }
}
