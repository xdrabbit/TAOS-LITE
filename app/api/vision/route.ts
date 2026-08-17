import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import {
  getLanguageLabel,
  isSupportedLanguageCode,
  type SupportedLanguageCode
} from "@/lib/realtime/languages";
import { getOpenAIKey } from "@/lib/translateProvider";
import { buildVisionInstructions, parseVisionResponse } from "@/lib/vision/prompts";

export const runtime = "nodejs";
export const maxDuration = 90;

const VISION_TIMEOUT_MS = 60000;

// The client downscales to ~1600px JPEG before sending (a raw phone photo
// would blow through Vercel's ~4.5 MB request-body limit anyway). This cap is
// the server-side backstop: ~4 MB of base64.
const MAX_IMAGE_CHARS = 5_500_000;

const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,/;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => null)) as {
    image?: string;
    targetLanguage?: string;
  } | null;
  const image = typeof body?.image === "string" ? body.image : "";
  const targetRaw = typeof body?.targetLanguage === "string" ? body.targetLanguage : "auto";

  if (!DATA_URL_RE.test(image)) {
    return NextResponse.json({ error: "Send a JPEG, PNG, or WebP image." }, { status: 400 });
  }
  if (image.length > MAX_IMAGE_CHARS) {
    return NextResponse.json({ error: "That photo is too large." }, { status: 413 });
  }
  if (targetRaw !== "auto" && !isSupportedLanguageCode(targetRaw)) {
    return NextResponse.json({ error: "Unsupported target language." }, { status: 400 });
  }

  const target =
    targetRaw === "auto"
      ? null
      : { code: targetRaw, label: getLanguageLabel(targetRaw as SupportedLanguageCode) };

  // Same model knob as the other quality-sensitive translation paths, with
  // its own override in case reading photos ever wants a different model
  // than paraphrasing speech.
  const model =
    process.env.OPENAI_VISION_MODEL?.trim() ||
    process.env.OPENAI_TRANSLATE_MODEL?.trim() ||
    "gpt-4.1";

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildVisionInstructions(target) },
          {
            role: "user",
            content: [
              { type: "text", text: "Read and translate the text in this photo." },
              { type: "image_url", image_url: { url: image, detail: "high" } }
            ]
          }
        ]
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS)
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail =
        payload && typeof payload === "object" ? JSON.stringify(payload) : `HTTP ${res.status}`;
      throw new Error(`Provider request failed: ${detail}`);
    }
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === "string" ? message.content : "";

    const result = parseVisionResponse(content);
    if (!result.original || !result.translation) {
      return NextResponse.json(
        {
          error:
            "No readable text was found in that photo. · No se encontró texto legible en esa foto."
        },
        { status: 422 }
      );
    }

    // Auto direction mirrors /api/video/process: English → Spanish,
    // everything else → English.
    const resolvedTarget: string = target
      ? target.code
      : result.sourceLang === "en"
        ? "es"
        : "en";

    return NextResponse.json({
      sourceLang: result.sourceLang,
      targetLanguage: resolvedTarget,
      original: result.original,
      translation: result.translation
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return NextResponse.json(
        { error: "Reading the photo took too long. Try again." },
        { status: 504 }
      );
    }
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json(
      { error: "Photo translation failed.", details: message },
      { status: 502 }
    );
  }
}
