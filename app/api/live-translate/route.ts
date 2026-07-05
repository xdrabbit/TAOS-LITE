import { NextRequest, NextResponse } from "next/server";
import {
  ProviderError,
  chatCompletion,
  getOpenAIKey
} from "@/lib/translateProvider";

export const runtime = "nodejs";

// Live "follow-along" endpoint. Optimized for latency, not fidelity: it returns
// a short micro-summary of the CONCEPT being spoken, not a real translation.
// Use case: Tom follows Liz's Spanish phone call in real time.

type LiveDirection = "es-en" | "en-es";

const DEFAULT_DIRECTION: LiveDirection = "es-en";
// Rolling window of prior chunks/summaries is capped server-side so a long
// call can't grow the prompt without bound.
const MAX_CONTEXT_ENTRIES = 10;

interface DirectionLabels {
  source: string;
  target: string;
}

const DIRECTION_LABELS: Record<LiveDirection, DirectionLabels> = {
  "es-en": { source: "Spanish", target: "English" },
  "en-es": { source: "English", target: "Spanish" }
};

function parseDirection(value: unknown): LiveDirection {
  return value === "en-es" ? "en-es" : DEFAULT_DIRECTION;
}

function parseContext(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-MAX_CONTEXT_ENTRIES);
}

function buildInstructions(labels: DirectionLabels): string {
  return (
    `You help someone follow a live ${labels.source} conversation in ${labels.target}. ` +
    `You are given a short, possibly fragmentary chunk of ${labels.source} speech. ` +
    `Do NOT translate word for word. Compress it to its CORE CONCEPT as a micro-summary ` +
    `of 3 to 12 words in ${labels.target} (e.g. "she's asking about the rent payment"). ` +
    `Use any provided conversation context to predict and disambiguate meaning when the ` +
    `chunk is fragmentary — educated guessing from the conversation flow is desired. ` +
    `If your summary is mostly a prediction or guess rather than clearly stated content, ` +
    `prefix it with "~". Output ONLY the micro-summary: no preamble, no quotes, no labels.`
  );
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
  const context = parseContext(payload.context);
  const labels = DIRECTION_LABELS[direction];

  const messages = [
    { role: "system" as const, content: buildInstructions(labels) },
    ...(context.length > 0
      ? [
          {
            role: "user" as const,
            content: `Conversation so far (oldest first):\n${context.join("\n")}`
          }
        ]
      : []),
    { role: "user" as const, content: `Latest ${labels.source} chunk:\n${text}` }
  ];

  try {
    const raw = await chatCompletion(apiKey, {
      messages,
      temperature: 0.2,
      maxTokens: 60
    });
    const isGuess = raw.startsWith("~");
    const concept = isGuess ? raw.slice(1).trim() : raw;
    return NextResponse.json({ concept, isGuess, direction });
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
