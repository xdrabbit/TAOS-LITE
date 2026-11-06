// Text → translation. The two chat completions /api/translate makes, lifted
// out of the route unchanged (2026-11-05) so /review's Redo can run a kept
// clip through exactly the pipeline the turn ran through — same model, same
// temperature, same prompts — rather than a hand-rolled copy. Nothing here
// changed in the move: the bodies, the fences and the comments are the
// route's, and the route calls these.
import type { SupportedLanguageCode } from "@/lib/realtime/languages";
import { buildAutoDetectInstructions, buildInstructions, type Tone } from "@/lib/translate/prompts";
import type { ContextTurn } from "@/lib/translate/context";
import { parseAutoSegments, type TranslatedSegment } from "@/lib/translate/segments";

// Production 2026-07-19: an OpenAI call stalled and this function hung the
// full 300s until Vercel killed it — the phone's fetch died with Safari's
// opaque "Load failed". Cap each upstream call well under maxDuration so a
// stall becomes a fast, retryable JSON error instead of a dead socket.
export const PARAPHRASE_TIMEOUT_MS = 60000;

// Full gpt-4.1 unless overridden — see paraphrase() for why this is not the
// shared OPENAI_PARAPHRASE_MODEL var.
export function getTranslateModel(): string {
  return process.env.OPENAI_TRANSLATE_MODEL?.trim() || "gpt-4.1";
}

export async function paraphrase(
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
export async function paraphraseAuto(
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
