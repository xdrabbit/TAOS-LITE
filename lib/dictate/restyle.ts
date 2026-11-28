// /dictate's two chat completions. A direct fetch modelled on paraphrase()
// (lib/translate/paraphrase.ts): the full translate model, temperature 0.2,
// and a timeout — not chatCompletion (lib/translateProvider.ts), which has no
// timeout and defaults to the mini model.
import { getTranslateModel } from "@/lib/translate/paraphrase";
import { buildDecoderInstructions, buildDictateInstructions } from "./prompt";
import type { DictateStyle } from "./style";

/**
 * Well under the route's maxDuration, for the reason paraphrase() records: a
 * stall that runs out the function's clock reaches the phone as Safari's
 * opaque "Load failed" instead of something retryable.
 */
export const DICTATE_RESTYLE_TIMEOUT_MS = 45000;

export interface DecodedMessage {
  /** English name of the language the message was written in. */
  sourceLanguage: string;
  /** The message, punctuated, in its original language. */
  cleaned: string;
  /** The faithful translation for the reader. */
  translation: string;
  /** Genuinely ambiguous places, briefly. Usually empty. */
  notes: string[];
}

const MAX_NOTES = 6;

async function complete(
  apiKey: string,
  system: string,
  text: string,
  json: boolean,
  timeoutMs: number
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: getTranslateModel(),
      temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: text }
      ]
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs)
  });

  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    // The status only. The provider's error body can echo the request, and
    // the request is somebody's dictation.
    throw Object.assign(new Error(`Model call failed: HTTP ${res.status}`), {
      upstreamStatus: res.status
    });
  }
  const choices = Array.isArray(payload?.choices) ? payload?.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  if (!content) throw new Error("Model response was empty.");
  return content;
}

/** Transcript → styled text, in the source language or `targetLabel`. */
export async function restyle(
  apiKey: string,
  raw: string,
  style: DictateStyle,
  sourceLabel: string,
  targetLabel: string | null,
  timeoutMs: number = DICTATE_RESTYLE_TIMEOUT_MS,
  words: string[] = []
): Promise<string> {
  return complete(
    apiKey,
    buildDictateInstructions(style, sourceLabel, targetLabel, words),
    raw,
    false,
    timeoutMs
  );
}

/**
 * Read the Decoder's JSON reply. Throws when either text is missing: half an
 * answer shown as a whole one is worse than "try again".
 */
export function parseDecoded(content: string): DecodedMessage {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error("Decoder response was not JSON.");
  }
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const cleaned = text(parsed?.cleaned);
  const translation = text(parsed?.translation);
  if (!cleaned || !translation) throw new Error("Decoder response was incomplete.");
  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.map(text).filter(Boolean).slice(0, MAX_NOTES)
    : [];
  return { sourceLanguage: text(parsed.source_language), cleaned, translation, notes };
}

/** Pasted message → cleaned original + translation + ambiguity notes. */
export async function decodeMessage(
  apiKey: string,
  raw: string,
  readerLabel: string,
  otherLabel: string,
  timeoutMs: number = DICTATE_RESTYLE_TIMEOUT_MS,
  words: string[] = []
): Promise<DecodedMessage> {
  return parseDecoded(
    await complete(
      apiKey,
      buildDecoderInstructions(readerLabel, otherLabel, undefined, words),
      raw,
      true,
      timeoutMs
    )
  );
}
