import { NextRequest, NextResponse } from "next/server";
import { getLanguageLabel, isSupportedLanguageCode } from "@/lib/realtime/languages";

export const runtime = "nodejs";
// 300s is the max on Vercel Pro. The client per-turn cap (MAX_TURN_DURATION_MS
// in TranslatorShell) must stay <= this, or a long turn can't be transcribed +
// paraphrased before the function is killed and the turn fails silently.
export const maxDuration = 300;

type Tone = "casual" | "detailed";

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

function parseTone(value: FormDataEntryValue | null): Tone {
  return value === "detailed" ? "detailed" : "casual";
}

function buildInstructions(sourceLabel: string, targetLabel: string, tone: Tone): string {
  const shared =
    `You are a live interpreter helping two people in a face-to-face conversation. ` +
    `The speaker talks in ${sourceLabel}. Render their meaning in natural, fluent ${targetLabel}. ` +
    `Speak in the FIRST PERSON as if you are the speaker — never narrate ("he says", "she is saying"). ` +
    `Do NOT translate word for word. Convey the concept, intent, and emotional tone. ` +
    `Output ONLY the ${targetLabel} translation: no preamble, no quotes, no notes, no language labels.`;

  if (tone === "detailed") {
    return (
      shared +
      ` This is an IMPORTANT conversation. Preserve every meaningful nuance, condition, number, name, ` +
      `and emotional weight. Be faithful and complete, but still natural and first-person. ` +
      `If the speaker rambles, organize the meaning clearly without losing detail.`
    );
  }

  return (
    shared +
    ` This is CASUAL conversation. Be warm, concise, and conversational. ` +
    `Capture the gist and feeling the way a close friend would relay it. Trim filler and repetition.`
  );
}

async function transcribe(apiKey: string, file: File, sourceLabel?: string): Promise<string> {
  const model = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-transcribe";
  const form = new FormData();
  form.append("file", file, file.name || "audio.webm");
  form.append("model", model);
  // A language hint sharpens accuracy; omit it in auto-detect mode so the model
  // is free to recognize whichever language was spoken.
  form.append(
    "prompt",
    sourceLabel
      ? `Spoken ${sourceLabel}. Transcribe verbatim with natural punctuation.`
      : "Transcribe verbatim with natural punctuation."
  );

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
  });

  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    // A micro-clip (rapid double-tap) or a mangled upload comes back as
    // "Audio file might be corrupted or unsupported". That's not a failure
    // worth showing raw JSON for — treat it as "nothing was heard" so the
    // caller returns its gentle bilingual retry message.
    const err = payload?.error as Record<string, unknown> | undefined;
    const msg = typeof err?.message === "string" ? err.message : "";
    if (/corrupted or unsupported|could not be decoded|file is empty/i.test(msg)) {
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
  const model = process.env.OPENAI_PARAPHRASE_MODEL?.trim() || "gpt-4.1-mini";

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

// Auto-detect mode: the model decides whether the transcript is English or
// Spanish and translates to the OTHER, returning both so the client knows the
// resolved direction (for voice + display).
async function paraphraseAuto(
  apiKey: string,
  text: string,
  tone: Tone
): Promise<{ detected: "en" | "es"; translation: string }> {
  const model = process.env.OPENAI_PARAPHRASE_MODEL?.trim() || "gpt-4.1-mini";
  const toneLine =
    tone === "detailed"
      ? "This is an IMPORTANT conversation: preserve nuance, numbers, names, and emotion."
      : "This is CASUAL conversation: warm, concise, friend-style; trim filler.";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: tone === "detailed" ? 0.2 : 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `The user's text is in either English or Spanish. Detect which. ` +
            `Then render its MEANING in the OTHER language as a natural, FIRST-PERSON concept paraphrase ` +
            `(never word-for-word, never narrate "he says"). ${toneLine} ` +
            `Respond ONLY with JSON: {"lang":"en"|"es","translation":"<text in the other language>"}.`
        },
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
  const detected: "en" | "es" = parsed.lang === "es" ? "es" : "en";
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
    // model decide EN vs ES and translate to the other.
    if (sourceLanguage === "auto") {
      const original = await transcribe(apiKey, audio);
      if (!original) {
        return NextResponse.json(
          { error: "Nothing was heard — try again. · No se escuchó nada — intenta de nuevo." },
          { status: 422 }
        );
      }
      const { detected, translation } = await paraphraseAuto(apiKey, original, tone);
      return NextResponse.json({
        original,
        translation,
        sourceLanguage: detected,
        targetLanguage: detected === "en" ? "es" : "en",
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
