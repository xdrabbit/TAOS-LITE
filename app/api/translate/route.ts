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
  isUnusableAudioError,
  parseTone,
  type Tone
} from "@/lib/translate/prompts";

export const runtime = "nodejs";
// 300s is the max on Vercel Pro. The client per-turn cap (MAX_TURN_DURATION_MS
// in TranslatorShell) must stay <= this, or a long turn can't be transcribed +
// paraphrased before the function is killed and the turn fails silently.
export const maxDuration = 300;

// Production 2026-07-19: an OpenAI call stalled and this function hung the
// full 300s until Vercel killed it — the phone's fetch died with Safari's
// opaque "Load failed". Cap each upstream call well under maxDuration so a
// stall becomes a fast, retryable JSON error instead of a dead socket.
// Transcription gets longer: it re-uploads up to 5 minutes of audio.
const TRANSCRIBE_TIMEOUT_MS = 120000;
const PARAPHRASE_TIMEOUT_MS = 60000;

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

// parseTone / buildInstructions / isUnusableAudioError live in
// lib/translate/prompts.ts so their behavior is unit-tested.

async function transcribe(
  apiKey: string,
  file: File,
  sourceLabel?: string,
  extraHint?: string
): Promise<string> {
  const model = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-transcribe";
  const form = new FormData();
  form.append("file", file, file.name || "audio.webm");
  form.append("model", model);
  // A language hint sharpens accuracy; omit it in auto-detect mode so the model
  // is free to recognize whichever language was spoken. Cantonese always gets
  // the colloquial-written-form hint or the transcript comes back as Standard
  // Written Chinese and reads as Mandarin.
  const base = sourceLabel
    ? `Spoken ${sourceLabel}. Transcribe verbatim with natural punctuation.`
    : "Transcribe verbatim with natural punctuation.";
  const hint = extraHint ?? (sourceLabel === "Cantonese" ? CANTONESE_STT_HINT : "");
  form.append("prompt", hint ? `${base} ${hint}` : base);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
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

async function paraphrase(
  apiKey: string,
  text: string,
  sourceLabel: string,
  targetLabel: string,
  tone: Tone
): Promise<string> {
  // Full gpt-4.1, not mini: field reports (7/23, Yellowstone) had casual-mode
  // translations drifting to a different meaning entirely — mini paraphrases
  // too loosely for a conversation that matters. Text tokens are cheap; the
  // realtime voice features dominate cost, not this. Deliberately NOT the
  // shared OPENAI_PARAPHRASE_MODEL var: that one is pinned to mini for the
  // latency-sensitive /live and chat routes, and a deployed env value would
  // silently drag this route back down to mini.
  const model = process.env.OPENAI_TRANSLATE_MODEL?.trim() || "gpt-4.1";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: tone === "detailed" ? 0.2 : 0.4,
      messages: [
        { role: "system", content: buildInstructions(sourceLabel, targetLabel, tone) },
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
    throw new Error(`Translation failed: ${detail}`);
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
// languages the transcript is, and translates to the other — returning both
// so the client knows the resolved direction (for voice + display).
async function paraphraseAuto(
  apiKey: string,
  text: string,
  tone: Tone,
  a: { code: SupportedLanguageCode; label: string },
  b: { code: SupportedLanguageCode; label: string }
): Promise<{ detected: SupportedLanguageCode; translation: string }> {
  const model = process.env.OPENAI_TRANSLATE_MODEL?.trim() || "gpt-4.1"; // full, see paraphrase()

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: tone === "detailed" ? 0.2 : 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildAutoDetectInstructions(a, b, tone) },
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
    throw new Error(`Translation failed: ${detail}`);
  }
  const choices = Array.isArray(payload?.choices) ? payload?.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = typeof message?.content === "string" ? message.content : "";
  let parsed: { lang?: string; translation?: string } = {};
  try {
    parsed = JSON.parse(content) as { lang?: string; translation?: string };
  } catch {
    /* fall through to defaults */
  }
  const detected: SupportedLanguageCode = parsed.lang === b.code ? b.code : a.code;
  const translation = typeof parsed.translation === "string" ? parsed.translation.trim() : "";
  if (!translation) throw new Error("Translation response was empty.");
  return { detected, translation };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server misconfiguration: missing OPENAI_API_KEY." },
        { status: 500 }
      );
    }

    const form = await req.formData();
    const audio = form.get("audio");
    const sourceLanguage = String(form.get("sourceLanguage") ?? "");
    const targetLanguage = String(form.get("targetLanguage") ?? "");
    const tone = parseTone(form.get("tone"));

    if (!(audio instanceof File) || audio.size === 0) {
      return NextResponse.json({ error: "An audio recording is required." }, { status: 400 });
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
      const original = await transcribe(apiKey, audio, undefined, autoHint);
      if (!original) {
        return NextResponse.json(
          { error: "Nothing was heard — try again. · No se escuchó nada — intenta de nuevo." },
          { status: 422 }
        );
      }
      const { detected, translation } = await paraphraseAuto(
        apiKey,
        original,
        tone,
        { code: pairA, label: getLanguageLabel(pairA) },
        { code: pairB, label: getLanguageLabel(pairB) }
      );
      return NextResponse.json({
        original,
        translation,
        sourceLanguage: detected,
        targetLanguage: detected === pairA ? pairB : pairA,
        tone,
        autoDetected: true
      });
    }

    if (!isSupportedLanguageCode(sourceLanguage) || !isSupportedLanguageCode(targetLanguage)) {
      return NextResponse.json({ error: "Unsupported language pair." }, { status: 400 });
    }
    if (sourceLanguage === targetLanguage) {
      return NextResponse.json(
        { error: "Source and target languages must differ." },
        { status: 400 }
      );
    }

    const sourceLabel = getLanguageLabel(sourceLanguage);
    const targetLabel = getLanguageLabel(targetLanguage);

    const original = await transcribe(apiKey, audio, sourceLabel);
    if (!original) {
      return NextResponse.json(
        { error: "Nothing was heard — try again. · No se escuchó nada — intenta de nuevo." },
        { status: 422 }
      );
    }

    const translation = await paraphrase(apiKey, original, sourceLabel, targetLabel, tone);

    return NextResponse.json({
      original,
      translation,
      sourceLanguage,
      targetLanguage,
      tone
    });
  } catch (error) {
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
