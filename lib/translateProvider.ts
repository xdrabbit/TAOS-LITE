// Shared OpenAI chat-completion helper for the translation API routes
// (POST /api/live-translate and POST /api/text-translate).
//
// This reuses the same provider (OpenAI), env var (OPENAI_API_KEY), and model
// (OPENAI_PARAPHRASE_MODEL, default gpt-4.1-mini — the fast/"mini" tier the app
// already uses for concept paraphrase) as app/api/translate/route.ts, so both
// new endpoints stay on the established pattern rather than inventing config.

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  /** Sampling temperature. Keep low for translation determinism. */
  temperature?: number;
  /** Cap on generated tokens; keep small on the latency-sensitive live route. */
  maxTokens?: number;
  /** When true, force a JSON object response (used for auto language detect). */
  jsonMode?: boolean;
  /** Override the model; defaults to the app's configured paraphrase model. */
  model?: string;
}

/**
 * Thrown when the upstream provider (OpenAI) returns a non-2xx response or an
 * empty completion. Routes map this to an HTTP 502 with a JSON error body.
 */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The OpenAI API key, trimmed, or null when it is not configured. */
export function getOpenAIKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? key : null;
}

/**
 * The chat model to use. Mirrors app/api/translate/route.ts: reuse the
 * OPENAI_PARAPHRASE_MODEL env var (the fast "mini" tier) and fall back to the
 * same default so no new configuration is introduced.
 */
export function getChatModel(): string {
  return process.env.OPENAI_PARAPHRASE_MODEL?.trim() || "gpt-4.1-mini";
}

/**
 * Call OpenAI's chat completions endpoint and return the trimmed message text.
 *
 * @throws {ProviderError} on a non-2xx response or an empty completion.
 */
export async function chatCompletion(
  apiKey: string,
  options: ChatCompletionOptions
): Promise<string> {
  const { messages, temperature = 0.3, maxTokens, jsonMode = false, model } = options;

  const body: Record<string, unknown> = {
    model: model ?? getChatModel(),
    temperature,
    messages
  };
  if (typeof maxTokens === "number") {
    body.max_tokens = maxTokens;
  }
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      cache: "no-store"
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network error";
    throw new ProviderError(`Failed to reach translation provider: ${detail}`);
  }

  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const detail =
      payload && typeof payload === "object" ? JSON.stringify(payload) : `HTTP ${res.status}`;
    throw new ProviderError(`Provider request failed: ${detail}`);
  }

  const choices = Array.isArray(payload?.choices) ? payload?.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  if (!content) {
    throw new ProviderError("Provider returned an empty completion.");
  }
  return content;
}
