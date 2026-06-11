import { NextRequest, NextResponse } from "next/server";
import { getLanguageLabel, isSupportedLanguageCode } from "@/lib/realtime/languages";

export const runtime = "nodejs";
export const maxDuration = 120;

type Tone = "casual" | "detailed";

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

async function transcribe(apiKey: string, file: File, sourceLabel: string): Promise<string> {
  const model = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-transcribe";
  const form = new FormData();
  form.append("file", file, file.name || "audio.webm");
  form.append("model", model);
  // A language hint sharpens accuracy; the prompt nudges punctuation/casing.
  form.append("prompt", `Spoken ${sourceLabel}. Transcribe verbatim with natural punctuation.`);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    cache: "no-store"
  });

  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
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
    cache: "no-store"
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
        { error: "Nothing was heard. Try recording again." },
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
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: "Translation pipeline failed.", details: message }, {
      status: 502
    });
  }
}
