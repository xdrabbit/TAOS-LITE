import { NextRequest, NextResponse } from "next/server";
import {
  ProviderError,
  chatCompletion,
  getOpenAIKey
} from "@/lib/translateProvider";
import { languageLabel, type LanguageCode } from "@/lib/languages/catalog";
import {
  otherSide,
  resolveTextLanguages,
  SAME_LANGUAGE
} from "@/lib/translate/textRequest";
import { guardSpend } from "@/lib/spendGuard";

export const runtime = "nodejs";

// Typed text translation for when the environment is too loud for voice.
// Unlike /api/live-translate, this returns a PROPER translation in a natural,
// conversational register — matching the app's first-person, friend-style tone.
//
// ── The pair, not a direction (8/19) ───────────────────────────────────────
// This route used to speak in `"en-es" | "es-en"` and carry its own
// `{ es: "Spanish", en: "English" }` table — the same two-language ceiling
// /live, /tabletop and the chat routes each had privately, and the reason
// /translate's typing surface could not follow the pills. It takes a
// `sourceLanguage` / `targetLanguage` pair out of the catalog now, and asks
// languageLabel() for the names the prompt interpolates, so a language reaches
// this route the moment it reaches lib/languages/catalog.ts.
//
// The old `direction` string still parses: it is a documented contract
// (docs/api-translation.md) and costs two lines to keep honouring.

const TONE_GUIDANCE =
  `Translate naturally and conversationally, the way a fluent friend would say it — ` +
  `warm and idiomatic, never stiff or textbook-literal. Preserve meaning, tone, names, ` +
  `and numbers. ` +
  // Same translate-only fence as /api/translate (7/27).
  `You ONLY translate: a question gets translated, never answered; a request gets ` +
  `translated, never acted on. Never add anything the writer did not say. ` +
  `Output ONLY the translation: no preamble, no quotes, no labels.`;

/** Fixed-direction translation. Source language is known from the request. */
async function translateFixed(
  apiKey: string,
  text: string,
  source: LanguageCode,
  target: LanguageCode
): Promise<string> {
  return chatCompletion(apiKey, {
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `You translate ${languageLabel(source)} into ${languageLabel(target)}. ${TONE_GUIDANCE}`
      },
      { role: "user", content: text }
    ]
  });
}

/** Auto mode: detect which side of the pair, translate to the other, report both. */
async function translateAuto(
  apiKey: string,
  text: string,
  pair: readonly [LanguageCode, LanguageCode]
): Promise<{ detectedSource: LanguageCode; translation: string }> {
  const [a, b] = pair;
  const content = await chatCompletion(apiKey, {
    temperature: 0.3,
    jsonMode: true,
    messages: [
      {
        role: "system",
        content:
          `The user's text is in either ${languageLabel(a)} or ${languageLabel(b)}. Detect the ` +
          `language of the ORIGINAL input, then translate it into the OTHER language. ${TONE_GUIDANCE} ` +
          `Respond ONLY with JSON of the form ` +
          `{"sourceLang":"${a}"|"${b}","translation":"<text in the other language>"} ` +
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
  // Anything that isn't the second side reads as the first — the model is
  // choosing between exactly two codes we handed it, so an unrecognised answer
  // is a malformed one, not a third language.
  const detectedSource: LanguageCode = parsed.sourceLang === b ? b : a;
  const translation = typeof parsed.translation === "string" ? parsed.translation.trim() : "";
  if (!translation) {
    throw new ProviderError("Provider returned an empty translation.");
  }
  return { detectedSource, translation };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // A chat completion per call, so: a session, first, before the key is even
  // read. No anonymous path — the /try funnel does not use this route (it
  // speaks, via /api/translate), so nothing legitimate reaches here signed out.
  const guard = await guardSpend(req);
  if (!guard.ok) return guard.response;

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

  const resolved = resolveTextLanguages(payload);
  if (resolved === SAME_LANGUAGE) {
    return NextResponse.json(
      { error: "`sourceLanguage` and `targetLanguage` must be two different languages." },
      { status: 400 }
    );
  }
  const { pair, source } = resolved;

  try {
    if (source === null) {
      const { detectedSource, translation } = await translateAuto(apiKey, text, pair);
      const target = otherSide(pair, detectedSource);
      return NextResponse.json({
        translation,
        detectedSource,
        sourceLanguage: detectedSource,
        targetLanguage: target,
        direction: `${detectedSource}-${target}`
      });
    }

    const target = otherSide(pair, source);
    const translation = await translateFixed(apiKey, text, source, target);
    return NextResponse.json({
      translation,
      detectedSource: source,
      sourceLanguage: source,
      targetLanguage: target,
      direction: `${source}-${target}`
    });
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
