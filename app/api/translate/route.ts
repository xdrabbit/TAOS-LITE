import { NextRequest, NextResponse } from "next/server";
import {
  getLanguageLabel,
  isSupportedLanguageCode,
  type SupportedLanguageCode
} from "@/lib/realtime/languages";
import {
  buildAutoDetectInstructions,
  buildInstructions,
  CANTONESE_STT_HINT,
  parseTone,
  type Tone
} from "@/lib/translate/prompts";
import { parseContextField, type ContextTurn } from "@/lib/translate/context";
import {
  autoTranscribeModel,
  defaultTranscribeModel,
  transcribeAudio
} from "@/lib/translate/transcribe";
import { guardSpend } from "@/lib/spendGuard";
import {
  parseAutoSegments,
  topLevelFromSegments,
  type TranslatedSegment
} from "@/lib/translate/segments";

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
// cap now lives with the transcriber, in lib/translate/transcribe.ts.
const PARAPHRASE_TIMEOUT_MS = 60000;

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

// Full gpt-4.1 unless overridden — see paraphrase() for why this is not the
// shared OPENAI_PARAPHRASE_MODEL var.
function getTranslateModel(): string {
  return process.env.OPENAI_TRANSLATE_MODEL?.trim() || "gpt-4.1";
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

// parseTone / buildInstructions / isUnusableAudioError live in
// lib/translate/prompts.ts so their behavior is unit-tested, and the
// transcriber itself now lives in lib/translate/transcribe.ts — unchanged,
// but shared, so /fast's mic gets this route's STT fences rather than a
// fourth hand-rolled copy of the same fetch without them.

async function paraphrase(
  apiKey: string,
  text: string,
  sourceLabel: string,
  targetLabel: string,
  tone: Tone,
  context: ContextTurn[] | null
): Promise<string> {
  // Full gpt-4.1, not mini: field reports (7/23, Yellowstone) had casual-mode
  // translations drifting to a different meaning entirely — mini paraphrases
  // too loosely for a conversation that matters. Text tokens are cheap; the
  // realtime voice features dominate cost, not this. Deliberately NOT the
  // shared OPENAI_PARAPHRASE_MODEL var: that one is pinned to mini for the
  // latency-sensitive /live and chat routes, and a deployed env value would
  // silently drag this route back down to mini.
  const model = getTranslateModel();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      // 0.2 for BOTH tones (casual was 0.4 until 7/27): the adversarial probe's
      // one leak was casual mode inventing an unspoken request, and the higher
      // temperature is the knob that invites it. Fidelity is the priority now
      // ("never loose meaning in Casual, no hallucinating, ever" — Tom, 7/27);
      // the casual REGISTER comes from the prompt, not the sampler.
      temperature: 0.2,
      messages: [
        { role: "system", content: buildInstructions(sourceLabel, targetLabel, tone, context) },
        { role: "user", content: text }
      ]
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(PARAPHRASE_TIMEOUT_MS)
  });

  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const detail =
      payload && typeof payload === "object" ? JSON.stringify(payload) : `HTTP ${res.status}`;
    throw Object.assign(new Error(`Translation failed: ${detail}`), { upstreamStatus: res.status });
  }

  const choices = Array.isArray(payload?.choices) ? payload?.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  if (!content) {
    throw new Error("Translation response was empty.");
  }
  return content;
}

// Auto-detect mode: the model decides which of the conversation PAIR's two
// languages each part of the transcript is, and translates each part to the
// other — returning ordered segments so the client knows every resolved
// direction (for voice + display). A one-language turn is one segment.
async function paraphraseAuto(
  apiKey: string,
  text: string,
  tone: Tone,
  a: { code: SupportedLanguageCode; label: string },
  b: { code: SupportedLanguageCode; label: string },
  context: ContextTurn[] | null
): Promise<TranslatedSegment<SupportedLanguageCode>[]> {
  const model = getTranslateModel(); // full, see paraphrase()

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2, // both tones — see paraphrase() for the 7/27 rationale
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildAutoDetectInstructions(a, b, tone, context) },
        { role: "user", content: text }
      ]
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(PARAPHRASE_TIMEOUT_MS)
  });

  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const detail =
      payload && typeof payload === "object" ? JSON.stringify(payload) : `HTTP ${res.status}`;
    throw Object.assign(new Error(`Translation failed: ${detail}`), { upstreamStatus: res.status });
  }
  const choices = Array.isArray(payload?.choices) ? payload?.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = typeof message?.content === "string" ? message.content : "";
  // source_lang is the language the SPEAKER used (see buildAutoDetectInstructions
  // for why the field is named this and must not be renamed back to "lang").
  // It becomes each segment's sourceLanguage for /api/tts, which is what picks
  // Tom's clone vs Liz's — read it wrong and the turn plays the wrong voice.
  //
  // A segment with a code outside the pair is folded into its neighbour, and a
  // reply with no usable segments falls back to the old single-source reading
  // (pair's first language when even that code is missing). Both are logged:
  // that silent fallback is exactly how the old inversion hid for five weeks.
  // See lib/translate/segments.ts.
  return parseAutoSegments(content, text, a.code, b.code).segments;
}

/**
 * The longest recording an anonymous /try caller may upload.
 *
 * Transcription is billed per second of audio, so this is the same kind of
 * fence as ANON_MAX_CHARS in /api/tts: not a quality limit, a bill limit.
 * Comfortably above a real /try turn (a sentence or two) and far below the
 * 5-minute cap a signed-in phone is allowed.
 */
const ANON_MAX_AUDIO_BYTES = 4 * 1024 * 1024;

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
    stageStarted: started
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
        ` err=${ok ? "?" : t.err === "?" ? "unhandled" : t.err}`
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
      const original = await transcribeAudio(apiKey, audio, {
        extraHint: autoHint,
        model: transcriber
      });
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
      // One segment is today's response exactly. Several keep the same
      // top-level fields (joined, direction from the first) so any reader of
      // them still works, plus the segments themselves.
      return NextResponse.json({
        ...top,
        tone,
        autoDetected: true,
        ...(segments.length > 1 ? { segments } : {})
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
    const original = await transcribeAudio(apiKey, audio, { sourceLabel });
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

    return NextResponse.json({
      original,
      translation,
      sourceLanguage,
      targetLanguage,
      tone
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
