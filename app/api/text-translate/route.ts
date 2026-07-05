import { NextRequest, NextResponse } from "next/server";
import {
  ProviderError,
  chatCompletion,
  getOpenAIKey
} from "@/lib/translateProvider";

export const runtime = "nodejs";

// Typed text translation for when the environment is too loud for voice.
// Unlike /api/live-translate, this returns a PROPER translation in a natural,
// conversational register — matching the app's first-person, friend-style tone.

type TextDirection = "es-en" | "en-es" | "auto";
type LangCode = "es" | "en";

const DEFAULT_DIRECTION: TextDirection = "auto";

const LANG_LABEL: Record<LangCode, string> = { es: "Spanish", en: "English" };

function parseDirection(value: unknown): TextDirection {
  if (value === "es-en" || value === "en-es" || value === "auto") return value;
  return DEFAULT_DIRECTION;
}

const TONE_GUIDANCE =
  `Translate naturally and conversationally, the way a fluent friend would say it — ` +
  `warm and idiomatic, never stiff or textbook-literal. Preserve meaning, tone, names, ` +
  `and numbers. Output ONLY the translation: no preamble, no quotes, no labels.`;

/** Fixed-direction translation. Source language is known from the direction. */
async function translateFixed(
  apiKey: string,
  text: string,
  source: LangCode,
  target: LangCode
): Promise<string> {
  return chatCompletion(apiKey, {
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `You translate ${LANG_LABEL[source]} into ${LANG_LABEL[target]}. ${TONE_GUIDANCE}`
      },
      { role: "user", content: text }
    ]
  });
}

/** Auto mode: detect Spanish vs English, translate to the other, report both. */
async function translateAuto(
  apiKey: string,
  text: string
): Promise<{ detectedSource: LangCode; translation: string }> {
  const content = await chatCompletion(apiKey, {
    temperature: 0.3,
    jsonMode: true,
    messages: [
      {
        role: "system",
        content:
          `The user's text is in either English or Spanish. Detect the language of the ` +
          `ORIGINAL input, then translate it into the OTHER language. ${TONE_GUIDANCE} ` +
          `Respond ONLY with JSON of the form ` +
          `{"sourceLang":"en"|"es","translation":"<text in the other language>"} ` +
          `where sourceLang is the language the INPUT was written in (not the translation).`
      },
      { role: "user", content: text }
    ]
  });

  let parsed: { sourceLang?: string; translation?: string } = {};
  try {
    parsed = JSON.parse(content) as { sourceLang?: string; translation?: string };
  } catch {
    throw new ProviderError("Provider returned malformed JSON for auto-detect.");
  }
  const detectedSource: LangCode = parsed.sourceLang === "es" ? "es" : "en";
  const translation = typeof parsed.translation === "string" ? parsed.translation.trim() : "";
  if (!translation) {
    throw new ProviderError("Provider returned an empty translation.");
  }
  return { detectedSource, translation };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "`text` is required and cannot be empty." }, { status: 400 });
  }

  const direction = parseDirection(payload.direction);

  try {
    if (direction === "auto") {
      const { detectedSource, translation } = await translateAuto(apiKey, text);
      return NextResponse.json({
        translation,
        detectedSource,
        direction: detectedSource === "es" ? "es-en" : "en-es"
      });
    }

    const source: LangCode = direction === "es-en" ? "es" : "en";
    const target: LangCode = source === "es" ? "en" : "es";
    const translation = await translateFixed(apiKey, text, source, target);
    return NextResponse.json({ translation, detectedSource: source, direction });
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json(
        { error: "Text translation provider failed.", details: error.message },
        { status: 502 }
      );
    }
    const details = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: "Text translation failed.", details }, { status: 502 });
  }
}
