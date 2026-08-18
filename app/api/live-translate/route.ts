import { NextRequest, NextResponse } from "next/server";
import {
  ProviderError,
  chatCompletion,
  getOpenAIKey
} from "@/lib/translateProvider";
import { languageLabel } from "@/lib/languages/catalog";
import { buildConceptInstructions } from "@/lib/live/instructions";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";

export const runtime = "nodejs";

// Live "follow-along" endpoint. Optimized for latency, not fidelity: it returns
// a short micro-summary of the CONCEPT being spoken, not a real translation.
// Use case: Tom follows Liz's Spanish phone call in real time.

// Rolling window of prior chunks/summaries is capped server-side so a long
// call can't grow the prompt without bound.
const MAX_CONTEXT_ENTRIES = 10;

// The direction used to be an "es-en" | "en-es" string with a hand-written
// label table beside it, which is exactly the two-language ceiling this route
// shared with the rest of /live. It is a pair of catalog codes now; the labels
// the prompt interpolates come from the catalog, which is where every other
// route already gets them.
const DEFAULT_SOURCE = "es";
const DEFAULT_TARGET = "en";

function parseLanguage(value: unknown, fallback: string): string {
  return typeof value === "string" && isSupportedLanguageCode(value) ? value : fallback;
}

function parseContext(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-MAX_CONTEXT_ENTRIES);
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

  const source = parseLanguage(payload.sourceLanguage, DEFAULT_SOURCE);
  const target = parseLanguage(payload.targetLanguage, DEFAULT_TARGET);
  const context = parseContext(payload.context);

  const messages = [
    { role: "system" as const, content: buildConceptInstructions(source, target) },
    ...(context.length > 0
      ? [
          {
            role: "user" as const,
            content: `Conversation so far (oldest first):\n${context.join("\n")}`
          }
        ]
      : []),
    { role: "user" as const, content: `Latest ${languageLabel(source)} chunk:\n${text}` }
  ];

  try {
    const raw = await chatCompletion(apiKey, {
      messages,
      temperature: 0.2,
      maxTokens: 60
    });
    const isGuess = raw.startsWith("~");
    const concept = isGuess ? raw.slice(1).trim() : raw;
    return NextResponse.json({ concept, isGuess, sourceLanguage: source, targetLanguage: target });
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json(
        { error: "Live translation provider failed.", details: error.message },
        { status: 502 }
      );
    }
    const details = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: "Live translation failed.", details }, { status: 502 });
  }
}
