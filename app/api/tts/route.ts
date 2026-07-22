import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Engine = "elevenlabs" | "openai";
type LangCode = "en" | "es";
type VoiceOverride = "tom" | "liz";

// Bound the upstream synthesis call well under maxDuration (60s): a stalled
// provider must become a fast, retryable JSON error, not a hung request the
// phone eventually reports as Safari's opaque "Load failed".
const SYNTH_TIMEOUT_MS = 45000;

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

// A multilingual-capable default voice so the same voice reads EN and ES well.
const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel (works with multilingual model)
const ELEVENLABS_TOM_VOICE = "tpOaz7u8rY4nup9rRUmh"; // Tom's male clone
const ELEVENLABS_LIZ_VOICE = "uOQZaXDzEW5WoyNfLPne"; // Liz's female clone
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

function elevenLabsVoiceId(
  sourceLanguage?: LangCode,
  targetLanguage?: LangCode,
  voice?: VoiceOverride
): string {
  // Tabletop asks for the opposite pairing (spoken Spanish reads out in Tom's
  // voice, spoken English in Liz's), so it names the clone explicitly instead
  // of relying on the direction mapping below.
  if (voice === "tom") return ELEVENLABS_TOM_VOICE;
  if (voice === "liz") return ELEVENLABS_LIZ_VOICE;
  // The voice follows the SPEAKER, so each person hears their partner's real
  // voice speaking their own language. (No env override here — it was forcing
  // the ES->EN side to the wrong clone.)
  if (sourceLanguage === "en" && targetLanguage === "es") {
    return ELEVENLABS_TOM_VOICE; // Tom speaks English -> Spanish in Tom's voice
  }
  if (sourceLanguage === "es" && targetLanguage === "en") {
    return ELEVENLABS_LIZ_VOICE; // Liz speaks Spanish -> English in Liz's voice
  }
  return process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE;
}

async function elevenLabs(
  text: string,
  sourceLanguage?: LangCode,
  targetLanguage?: LangCode,
  latency?: "flash",
  voice?: VoiceOverride
): Promise<NextResponse> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing ELEVENLABS_API_KEY." }, { status: 500 });
  }
  const voiceId = elevenLabsVoiceId(sourceLanguage, targetLanguage, voice);
  // /live sends latency:"flash" — trade a little clone fidelity for the
  // lowest-latency model so spoken concepts don't lag the conversation.
  const model =
    latency === "flash"
      ? process.env.ELEVENLABS_FLASH_MODEL?.trim() || "eleven_flash_v2_5"
      : process.env.ELEVENLABS_MODEL?.trim() || "eleven_turbo_v2_5"; // low-latency, multilingual

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
      cache: "no-store",
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS)
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
    cache: "no-store",
    signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS)
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
      latency?: string;
      voice?: string;
    };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const engine: Engine = body.engine === "openai" ? "openai" : "elevenlabs";
    const latency = body.latency === "flash" ? ("flash" as const) : undefined;
    const voice: VoiceOverride | undefined =
      body.voice === "tom" || body.voice === "liz" ? body.voice : undefined;

    if (!text) {
      return NextResponse.json({ error: "Text is required." }, { status: 400 });
    }

    // `await` (not a bare returned promise) so a thrown timeout lands in the
    // catch below rather than escaping the handler as a generic 500.
    return engine === "openai"
      ? await openai(text)
      : await elevenLabs(text, body.sourceLanguage, body.targetLanguage, latency, voice);
  } catch (error) {
    if (isTimeout(error)) {
      return NextResponse.json(
        { error: "The voice service took too long. Please try again." },
        { status: 504 }
      );
    }
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: "TTS failed.", details: message }, { status: 500 });
  }
}
