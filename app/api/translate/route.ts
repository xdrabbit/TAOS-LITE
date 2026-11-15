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
import {
  getTranslateModel,
  paraphrase,
  paraphraseAuto,
  PARAPHRASE_TIMEOUT_MS
} from "@/lib/translate/paraphrase";
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
import {
  HOME_MAX_CHUNKS,
  parsePriorField,
  stitchTranscripts,
  translateTimeoutFor,
  weaveSegments,
  weaveTranslations,
  type ChunkResult,
  type TurnPiece
} from "@/lib/translate/longTurn";
import { assembleReviewAudio, canKeepChunkedTurns, parseTurnId, stageReviewPart } from "@/lib/review/chunks";

export const runtime = "nodejs";
// 300s is the max on Vercel Pro, and it bounds ONE RECORDING, not one turn:
// the home screen records a long turn in chunks of at most HOME_CHUNK_MS
// (lib/translate/longTurn.ts — 4.5 minutes) and sends each as its own
// request, so no single clip here is ever longer than this function can
// transcribe. A chunk length above ~300 s would fail silently; keep it under.
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
  // ── Long turns, recorded in chunks (2026-11-15) ──────────────────────────
  /** How many chunks the turn had. 1 for every turn that fit in one. */
  chunks: number;
  /** How many of them failed transcription and became a lost marker. */
  chunkFail: number;
  /**
   * How long the phone waited, after the speaker stopped, for the earlier
   * chunks' transcripts before it could send this request — the phone's
   * clock. 0 when they were already back, and on a one-chunk turn.
   */
  stitchMs: number;
  /**
   * True on a PART request: one chunk that closed mid-turn, transcribed and
   * nothing else. It logs [taos-translate-chunk], so [taos-translate-timing]
   * stays one line per TURN.
   */
  part: boolean;
  chunkIndex: number | "?";
  chunkMs: number | "?";
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
//
// On a chunked turn every chunk gets this on its own, against its OWN length.
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
//
// A chunked turn is kept as ONE file, like every other turn: the parts
// staged by the earlier requests are joined with this request's chunk
// (lib/review/chunks.ts), and rec_ms is the whole turn's.
function keepForReview(input: {
  id: string;
  user: Speaker | null;
  keep: boolean;
  audio: File | null;
  audioMime: string;
  chunked: { turnId: string | null; priorCount: number } | null;
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
  const { audio, t, chunked } = input;
  const user = input.user;
  if (chunked ? !chunked.turnId : !audio) return null;
  if (chunked && !canKeepChunkedTurns()) {
    // No ffmpeg in this build: the chunks cannot be one file, so the turn is
    // not kept and no row is promised (lib/review/chunks.ts).
    console.log("[taos-review] keep_skipped surface=home code=no_ffmpeg");
    return null;
  }
  const whole: Promise<ArrayBuffer | Uint8Array | null> = chunked
    ? (async () => {
        const assembled = await assembleReviewAudio({
          userId: user.id,
          turnId: chunked.turnId as string,
          priorCount: chunked.priorCount,
          finalAudio: audio ? new Uint8Array(await audio.arrayBuffer()) : null,
          mime: input.audioMime
        });
        if (!assembled) console.error("[taos-review] keep_failed surface=home code=concat_failed");
        return assembled?.bytes ?? null;
      })()
    : (audio as File).arrayBuffer();
  waitUntil(
    whole
      .then((bytes) =>
        bytes
          ? keepTurnForReview({
              id: input.id,
              user,
              surface: "home",
              mode: input.mode,
              audio: bytes,
              audioMime: input.audioMime,
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
          : null
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
    normMs: "?",
    chunks: 1,
    chunkFail: 0,
    stitchMs: 0,
    part: false,
    chunkIndex: "?",
    chunkMs: "?"
  };
  let res: NextResponse | undefined;
  try {
    res = await handle(req, t);
    return res;
  } finally {
    const http = res?.status ?? 500;
    const ok = http >= 200 && http < 300;
    if (t.part) {
      // A chunk that closed mid-turn: transcription only. Same rule as the
      // line below — codes, counts and milliseconds, never a word of text.
      console.log(
        `[taos-translate-chunk] status=${ok ? "ok" : "error"} http=${http} mode=${t.mode}` +
          ` src=${t.src} index=${t.chunkIndex} chunk_ms=${t.chunkMs} audio_bytes=${t.audioBytes}` +
          ` audio_mime=${t.audioMime} transcribe_ms=${t.transcribeMs} transcribe_model=${t.transcribeModel}` +
          ` guard_ms=${t.guardMs} form_ms=${t.formMs} total_ms=${since(started)} src_chars=${t.srcChars}` +
          ` cold=${cold} retry=${attemptFlag(req)} err=${ok ? "?" : t.err === "?" ? "unhandled" : t.err}` +
          ` wps=${t.wps} retry_stt=${t.retryStt} stt1_words=${t.stt1Words} stt2_words=${t.stt2Words}` +
          ` stt_picked=${t.sttPicked} norm_gain_db=${t.normGainDb}`
      );
    } else {
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
          ` norm_gain_db=${t.normGainDb} norm_ms=${t.normMs}` +
          ` chunks=${t.chunks} chunk_fail=${t.chunkFail} stitch_ms=${t.stitchMs}`
      );
    }
  }
}

/** Which way this request translates, resolved from the form. */
type Direction =
  | {
      mode: "auto";
      pairA: SupportedLanguageCode;
      pairB: SupportedLanguageCode;
      autoHint: string | undefined;
      transcriber: string;
    }
  | {
      mode: "manual";
      sourceLanguage: SupportedLanguageCode;
      targetLanguage: SupportedLanguageCode;
      sourceLabel: string;
      targetLabel: string;
    };

/** One recording → its transcript, with the one bounded retry. */
async function transcribeClip(
  apiKey: string,
  sttAudio: File,
  t: TranslateTiming,
  clipSeconds: number,
  dir: Direction
): Promise<string> {
  if (dir.mode === "auto") {
    // The retry's hint is decided from the FIRST transcript: the language
    // it locked onto is the one it heard first, so the retry is hinted
    // toward the pair's other side (null when that cannot be told).
    const first = await transcribeAudio(apiKey, sttAudio, { extraHint: dir.autoHint, model: dir.transcriber });
    const verdict = shortTranscriptVerdict(first, clipSeconds);
    t.stt1Words = verdict.words;
    t.wps = verdict.wps;
    if (!verdict.short) return first;
    const other = otherPairLanguage(first, dir.pairA, dir.pairB);
    const hint = other && isSupportedLanguageCode(other) ? { code: other, label: getLanguageLabel(other) } : null;
    return retryShort(apiKey, sttAudio, t, first, hint, dir.autoHint);
  }
  // Manual direction: the language is known, so the retry keeps the same
  // hint and only changes the model.
  const first = await transcribeAudio(apiKey, sttAudio, { sourceLabel: dir.sourceLabel });
  const verdict = shortTranscriptVerdict(first, clipSeconds);
  t.stt1Words = verdict.words;
  t.wps = verdict.wps;
  return verdict.short
    ? retryShort(apiKey, sttAudio, t, first, { code: dir.sourceLanguage, label: dir.sourceLabel }, undefined)
    : first;
}

const NOTHING_HEARD = "Nothing was heard — try again. · No se escuchó nada — intenta de nuevo.";

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
    const audioField = form.get("audio");
    const audio = audioField instanceof File && audioField.size > 0 ? audioField : null;
    const sourceLanguage = String(form.get("sourceLanguage") ?? "");
    const targetLanguage = String(form.get("targetLanguage") ?? "");
    const tone = parseTone(form.get("tone"));
    // The last few turns of this conversation, for disambiguation only
    // (lib/translate/context.ts). Null on anything malformed — the turn then
    // translates exactly as it did before context existed. Request-only:
    // never logged, never saved, never echoed back.
    const context = parseContextField(form.get("context"));
    // How long the phone recorded, by its own clock — the WHOLE turn. The
    // short-transcript check needs the clip's length, and a MediaRecorder
    // WebM does not carry one; absent, the length is estimated from the bytes.
    const recMs = intField(form, "rec_ms");
    t.recMs = recMs ?? "?";
    t.mode = sourceLanguage === "auto" ? "auto" : "manual";
    if (sourceLanguage === "auto") t.src = "auto";
    else if (isSupportedLanguageCode(sourceLanguage)) t.src = sourceLanguage;
    t.tgt = isSupportedLanguageCode(targetLanguage) ? targetLanguage : "?";
    if (audioField instanceof File) {
      t.audioBytes = audioField.size;
      t.audioMime = audioField.type.replace(/\s+/g, "") || "?";
    }

    // ── A long turn's chunk fields (lib/translate/longTurn.ts) ─────────────
    // `chunk_part=1`: a chunk that closed while the speaker is still talking
    // — transcribe it and answer with its text; no translation.
    // `prior`: this is the turn's LAST chunk, and these are the earlier
    // chunks' transcripts (or their loss) — stitch, then translate once.
    // Neither present: a one-recording turn, handled exactly as it always was.
    const isPart = form.get("chunk_part") === "1";
    const priorRaw = form.get("prior");
    const chunked = isPart || priorRaw !== null;
    const chunkMs = intField(form, "chunk_ms");
    const turnId = parseTurnId(form.get("turn_id"));
    let prior: ChunkResult[] | null = null;
    t.part = isPart;
    if (chunked) {
      t.chunkMs = chunkMs ?? "?";
      // The anonymous /try allowance is one short recording per request and
      // is priced that way (ANON_MAX_AUDIO_BYTES). A chunked turn would be a
      // way around it, so it is refused outright.
      if (guard.anonymous) {
        t.err = "chunk_anonymous";
        return NextResponse.json({ error: "Long turns need a signed-in account." }, { status: 400 });
      }
      const index = intField(form, "chunk_index") ?? 0;
      t.chunkIndex = index;
      if (index >= HOME_MAX_CHUNKS || (isPart && priorRaw !== null)) {
        t.err = "bad_chunk";
        return NextResponse.json({ error: "Malformed long-turn request." }, { status: 400 });
      }
      if (!isPart) {
        prior = parsePriorField(priorRaw);
        if (!prior) {
          t.err = "bad_prior";
          return NextResponse.json({ error: "Malformed long-turn request." }, { status: 400 });
        }
      }
    }

    // A final request may arrive with no audio of its own: the speaker
    // stopped in the instant after a chunk rolled. The earlier chunks are
    // the turn. Everything else needs a recording.
    if (!audio && !prior) {
      t.err = "no_audio";
      return NextResponse.json({ error: "An audio recording is required." }, { status: 400 });
    }

    if (audio && guard.anonymous && audio.size > ANON_MAX_AUDIO_BYTES) {
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
    let sttAudio: File | null = audio;
    let decodedSeconds: number | null = null;
    if (audio && sttNormalizeEnabled(guard.user?.email)) {
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
    // THIS recording's length: on a chunked turn that is the chunk's, not
    // the turn's — words-per-second is measured against the audio it is for.
    const clipSeconds = estimateClipSeconds({
      recMs: chunked ? chunkMs : recMs,
      decodedSeconds,
      bytes: audio?.size ?? 0,
      mime: audio?.type ?? ""
    });

    // ── Direction ──────────────────────────────────────────────────────────
    let dir: Direction;
    if (sourceLanguage === "auto") {
      // Auto-detect direction: transcribe with no language hint, then let the
      // model decide which of the conversation pair's two languages it heard
      // and translate to the other. The pair comes from the client's language
      // picker (pairA/pairB); absent fields keep the historic en/es behavior.
      const pairARaw = String(form.get("pairA") ?? "en");
      const pairBRaw = String(form.get("pairB") ?? "es");
      const pairA: SupportedLanguageCode = isSupportedLanguageCode(pairARaw) ? pairARaw : "en";
      let pairB: SupportedLanguageCode = isSupportedLanguageCode(pairBRaw) ? pairBRaw : "es";
      if (pairB === pairA) pairB = pairA === "en" ? "es" : "en";
      dir = {
        mode: "auto",
        pairA,
        pairB,
        // In auto mode with Cantonese in the pair, the transcriber still needs
        // the colloquial-written-form hint — otherwise zh/yue speech both come
        // back as Standard Written Chinese and detection can't tell them apart.
        autoHint: pairA === "yue" || pairB === "yue" ? CANTONESE_STT_HINT : undefined,
        // Auto turns may run on their own transcriber (OPENAI_AUTO_TRANSCRIBE_MODEL):
        // production's default drops one language from a mixed clip.
        transcriber: autoTranscribeModel()
      };
    } else {
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
      dir = {
        mode: "manual",
        sourceLanguage,
        targetLanguage,
        sourceLabel: getLanguageLabel(sourceLanguage),
        targetLabel: getLanguageLabel(targetLanguage)
      };
    }

    // ── Transcribe this recording ──────────────────────────────────────────
    // No model passed on a manual turn, so transcribeAudio() uses the default.
    t.transcribeModel = dir.mode === "auto" ? dir.transcriber : defaultTranscribeModel();
    t.stage = "transcribe";
    t.stageStarted = performance.now();
    // null = this chunk's transcription FAILED. Only a final request with
    // earlier chunks can carry on from that; for everything else it throws.
    let heard: string | null = "";
    let sttError: unknown = null;
    if (sttAudio) {
      try {
        heard = await transcribeClip(apiKey, sttAudio, t, clipSeconds, dir);
      } catch (e) {
        sttError = e;
        heard = null;
      }
    }
    t.transcribeMs = since(t.stageStarted);

    if (isPart) {
      // The audio is staged for review only for a speaker who opted in — and
      // staged even when this chunk's transcription failed, so the kept file
      // is the whole turn and Redo gets a second try at the part that was lost.
      if (audio && turnId && guard.user && canKeepChunkedTurns() && (await keepPromise)) {
        const user = guard.user;
        waitUntil(
          audio
            .arrayBuffer()
            .then((bytes) =>
              stageReviewPart({
                userId: user.id,
                turnId,
                index: typeof t.chunkIndex === "number" ? t.chunkIndex : 0,
                audio: bytes,
                mime: audio.type || "audio/webm"
              })
            )
            .catch(() => false)
        );
      }
      if (sttError) throw sttError;
      // The chunk's text goes back to the phone, which holds it until the
      // turn ends. An empty transcript is an answer (a quiet stretch), not a
      // failure.
      const text = heard ?? "";
      t.srcChars = text.length;
      return NextResponse.json({ chunk: { index: t.chunkIndex, text } });
    }
    // A one-recording turn has nothing to fall back on; a long turn's last
    // chunk does (the earlier chunks), and becomes a lost marker instead.
    if (sttError && !prior) throw sttError;

    // ── Stitch (a chunked turn only) ───────────────────────────────────────
    let original = heard ?? "";
    // The runs of speech to translate. One — the whole text — unless a chunk
    // was lost; then one per side of each hole (lib/translate/longTurn.ts).
    let pieces: TurnPiece[] = [{ kind: "text", text: original }];
    let markerLang: string = dir.mode === "manual" ? dir.sourceLanguage : dir.pairA;
    if (prior) {
      const parts: ChunkResult[] = audio ? [...prior, { text: heard, ms: chunkMs ?? 0 }] : prior;
      markerLang = String(form.get("marker_lang") ?? "").slice(0, 12) || markerLang;
      const stitched = stitchTranscripts(parts, markerLang);
      t.chunks = stitched.chunks;
      t.chunkFail = stitched.failed;
      t.stitchMs = intField(form, "stitch_ms") ?? 0;
      if (!stitched.heard && stitched.failed > 0) {
        // Every chunk that could have carried words failed. There is nothing
        // to translate, and "nothing was heard" would be a lie.
        t.err = "chunks_failed";
        return NextResponse.json(
          { error: "Translation pipeline failed.", details: "The recording could not be transcribed." },
          { status: 502 }
        );
      }
      // Markers alone are not a turn.
      original = stitched.heard ? stitched.text : "";
      pieces = stitched.failed > 0 ? stitched.pieces : [{ kind: "text", text: original }];
    }
    const runs = pieces.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    t.srcChars = original.length;
    if (!original) {
      t.err = "nothing_heard";
      return NextResponse.json({ error: NOTHING_HEARD }, { status: 422 });
    }

    // ── Translate: once, the whole text (each side of a hole, if one) ──────
    const timeoutFor = (text: string) => translateTimeoutFor(text.length, PARAPHRASE_TIMEOUT_MS);
    const audioMime = audio?.type || String(form.get("audio_mime") ?? "") || "audio/webm";
    const chunkedKeep = prior ? { turnId, priorCount: prior.length } : null;

    if (dir.mode === "auto") {
      t.stage = "translate";
      t.stageStarted = performance.now();
      const { pairA, pairB } = dir;
      const perRun = await Promise.all(
        runs.map((text) =>
          paraphraseAuto(
            apiKey,
            text,
            tone,
            { code: pairA, label: getLanguageLabel(pairA) },
            { code: pairB, label: getLanguageLabel(pairB) },
            context,
            timeoutFor(text)
          )
        )
      );
      const segments = runs.length === 1 && pieces.length === 1 ? perRun[0] : weaveSegments(pieces, perRun, markerLang);
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
          .join(",")} src_chars=${original.length} ctx=${ctxTurns} transcriber=${dir.transcriber} ms=${
          Date.now() - startedAt
        }`
      );
      const reviewId = keepForReview({
        id: crypto.randomUUID(),
        user: guard.user,
        keep: await keepPromise,
        audio,
        audioMime,
        chunked: chunkedKeep,
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

    t.stage = "translate";
    t.stageStarted = performance.now();
    const { sourceLabel, targetLabel } = dir;
    const translations = await Promise.all(
      runs.map((text) => paraphrase(apiKey, text, sourceLabel, targetLabel, tone, context, timeoutFor(text)))
    );
    const translation =
      runs.length === 1 && pieces.length === 1
        ? translations[0]
        : weaveTranslations(pieces, translations, dir.targetLanguage);
    t.translateMs = since(t.stageStarted);
    t.outChars = translation.length;

    const reviewId = keepForReview({
      id: crypto.randomUUID(),
      user: guard.user,
      keep: await keepPromise,
      audio,
      audioMime,
      chunked: chunkedKeep,
      mode: "manual",
      sourceLang: dir.sourceLanguage,
      targetLang: dir.targetLanguage,
      original,
      translation,
      segments: null,
      t,
      startedAt
    });

    return NextResponse.json({
      original,
      translation,
      sourceLanguage: dir.sourceLanguage,
      targetLanguage: dir.targetLanguage,
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
