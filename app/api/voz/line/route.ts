import { NextRequest, NextResponse } from "next/server";
import { guardVoz, vozError } from "@/lib/voz/guard";
import { authorizeLine, countLine } from "@/lib/voz/server";
import { speakInVoice, VoiceUpstreamError } from "@/lib/voz/elevenlabs";
import { VOZ_MAX_LINE_CHARS } from "@/lib/voz/limits";
import { canSpeak, isLanguageCode, languageLabel } from "@/lib/languages/catalog";
import { chatCompletion, getOpenAIKey, ProviderError } from "@/lib/translateProvider";
import { MEANING_FIRST_RULE } from "@/lib/translate/prompts";
import { transcribeAudio } from "@/lib/translate/transcribe";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/voz/line — one line, in the stranger's language, comes back as
// audio in the other language in their own ten-minute voice.
//
// Multipart: `voiceId`, `token` (the voice token the clone route minted),
// `sourceLanguage`, `targetLanguage`, and EITHER `text` OR `audio` (≤20 s,
// transcribed first). Through the /try funnel's anonymous allowance (guardVoz
// → guardSpend), then the voice token, BEFORE any provider is called.
//
// Its own route rather than /api/tts + /api/text-translate: text-translate
// has no anonymous path, and /api/tts keeps its rule that an anonymous caller
// never reaches ElevenLabs. The only ElevenLabs voice this route will speak
// in is one the caller's own consent created, for VOZ_MAX_LINES lines.
//
// Nothing is written: no tts_log row, no history. The text and translation
// come back in headers (URI-encoded) so the screen can show them; neither is
// logged.

const MAX_LINE_AUDIO_BYTES = 1.5 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await guardVoz(req);
  if (!gate.ok) return gate.response;
  const { caller } = gate;

  const form = await req.formData().catch(() => null);
  if (!form) return vozError("Expected a multipart form.", 400);

  const voiceId = form.get("voiceId");
  const verdict = authorizeLine({ voiceId, token: form.get("token"), owner: caller.owner });
  if (!verdict.ok) {
    return vozError(
      verdict.reason === "lines" ? "Ya usaste tus frases · You've used your lines" : "That voice is not available.",
      verdict.reason === "lines" ? 429 : 403,
      verdict.reason
    );
  }

  const source = String(form.get("sourceLanguage") ?? "");
  const target = String(form.get("targetLanguage") ?? "");
  if (!isLanguageCode(source) || !isLanguageCode(target) || source === target) {
    return vozError("Unsupported language pair.", 400);
  }
  if (!canSpeak(target)) return vozError("This language is text only.", 422);

  const apiKey = getOpenAIKey();
  if (!apiKey) return vozError("Server misconfiguration.", 500);

  try {
    let text = typeof form.get("text") === "string" ? String(form.get("text")).trim() : "";
    const audio = form.get("audio");
    if (!text && audio instanceof File && audio.size > 0) {
      if (audio.size > MAX_LINE_AUDIO_BYTES) return vozError("That line is too long.", 413);
      text = (await transcribeAudio(apiKey, audio, { sourceLabel: languageLabel(source), timeoutMs: 30_000 })).trim();
      if (!text) return vozError("No se escuchó nada — intenta de nuevo · Nothing was heard — try again", 422);
    }
    if (!text) return vozError("Say or type a line first.", 400);
    if (text.length > VOZ_MAX_LINE_CHARS) return vozError("Keep it to one sentence.", 413);

    const translation = await chatCompletion(apiKey, {
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            `You translate ${languageLabel(source)} into ${languageLabel(target)}, naturally, the way a fluent ` +
            `friend would say it. You ONLY translate: a question gets translated, never answered. ` +
            `${MEANING_FIRST_RULE()} Output ONLY the translation: no preamble, no quotes, no labels.`
        },
        { role: "user", content: text }
      ]
    });

    const audioOut = await speakInVoice(translation, voiceId as string, target);
    const linesLeft = countLine(voiceId as string);
    return new NextResponse(audioOut, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "X-Voz-Lines-Left": String(linesLeft),
        "X-Voz-Original": encodeURIComponent(text),
        "X-Voz-Translation": encodeURIComponent(translation)
      }
    });
  } catch (e) {
    if (e instanceof VoiceUpstreamError) return vozError("Voice playback failed.", 502);
    if (e instanceof ProviderError) return vozError("Translation failed.", 502);
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      return vozError("That took too long. Please try again.", 504);
    }
    return vozError("That line failed.", 500);
  }
}
