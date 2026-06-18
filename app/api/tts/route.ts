import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Engine = "elevenlabs" | "openai";
type LangCode = "en" | "es";

// A multilingual-capable default voice so the same voice reads EN and ES well.
const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel (works with multilingual model)
const ELEVENLABS_TOM_VOICE = "uOQZaXDzEW5WoyNfLPne"; // Tom's clone — reads EN->ES
const ELEVENLABS_LIZMA_VOICE = "dWtid9SQ2W6xrE8V2T82"; // Liz's clone ("lizma") — reads ES->EN
const DEFAULT_OPENAI_VOICE = "nova";

function audioResponse(buffer: ArrayBuffer): NextResponse {
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store"
    }
  });
}

function elevenLabsVoiceId(sourceLanguage?: LangCode, targetLanguage?: LangCode): string {
  // Tom speaks EN -> Liz hears Spanish in Tom's voice.
  if (sourceLanguage === "en" && targetLanguage === "es") {
    return ELEVENLABS_TOM_VOICE;
  }
  // Liz speaks ES -> Tom hears English in Liz's ("lizma") voice.
  if (sourceLanguage === "es" && targetLanguage === "en") {
    return ELEVENLABS_LIZMA_VOICE;
  }
  return process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE;
}

async function elevenLabs(
  text: string,
  sourceLanguage?: LangCode,
  targetLanguage?: LangCode
): Promise<NextResponse> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing ELEVENLABS_API_KEY." }, { status: 500 });
  }
  const voiceId = elevenLabsVoiceId(sourceLanguage, targetLanguage);
  const model = process.env.ELEVENLABS_MODEL?.trim() || "eleven_turbo_v2_5"; // low-latency, multilingual

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.4, similarity_boost: 0.8 }
      }),
      cache: "no-store"
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => `HTTP ${res.status}`);
    return NextResponse.json({ error: "ElevenLabs TTS failed.", details: detail }, { status: 502 });
  }
  return audioResponse(await res.arrayBuffer());
}

async function openai(text: string): Promise<NextResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
  }
  const model = process.env.OPENAI_TTS_MODEL?.trim() || "gpt-4o-mini-tts";
  const voice = process.env.OPENAI_TTS_VOICE?.trim() || DEFAULT_OPENAI_VOICE;

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
    cache: "no-store"
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => `HTTP ${res.status}`);
    return NextResponse.json({ error: "OpenAI TTS failed.", details: detail }, { status: 502 });
  }
  return audioResponse(await res.arrayBuffer());
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      text?: string;
      engine?: string;
      sourceLanguage?: LangCode;
      targetLanguage?: LangCode;
    };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const engine: Engine = body.engine === "openai" ? "openai" : "elevenlabs";

    if (!text) {
      return NextResponse.json({ error: "Text is required." }, { status: 400 });
    }

    return engine === "openai"
      ? openai(text)
      : elevenLabs(text, body.sourceLanguage, body.targetLanguage);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: "TTS failed.", details: message }, { status: 500 });
  }
}
