import { NextRequest, NextResponse } from "next/server";
import {
  gatedElevenLabsVoiceId,
  type TtsLangCode as LangCode,
  type VoiceOverride
} from "@/lib/tts/voice";
import { PERSONAL_VOICE_HEADER, personalVoiceUnlocked } from "@/lib/tts/personalVoice";
import { canSpeak, isLanguageCode } from "@/lib/languages/catalog";

export const runtime = "nodejs";
export const maxDuration = 60;

type Engine = "elevenlabs" | "openai";

// Bound the upstream synthesis call well under maxDuration (60s): a stalled
// provider must become a fast, retryable JSON error, not a hung request the
// phone eventually reports as Safari's opaque "Load failed".
const SYNTH_TIMEOUT_MS = 45000;

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

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

// Cloned-voice selection lives in lib/tts/voice.ts (voice follows the
// SPEAKER — see the unit tests that pin the rule), behind the personal-voice
// gate in lib/tts/personalVoice.ts. The clone ids are resolved HERE, on the
// server, from a speaker direction: a client never names a voice id, so a
// phone without the code cannot reach one however it shapes the request.

async function elevenLabs(
  text: string,
  unlocked: boolean,
  sourceLanguage?: LangCode,
  targetLanguage?: LangCode,
  latency?: "flash",
  voice?: VoiceOverride
): Promise<NextResponse> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing ELEVENLABS_API_KEY." }, { status: 500 });
  }
  const voiceId = gatedElevenLabsVoiceId(unlocked, sourceLanguage, targetLanguage, voice);
  // /live sends latency:"flash" — trade a little clone fidelity for the
  // lowest-latency model so spoken concepts don't lag the conversation.
  // Cantonese output overrides both: turbo/flash don't speak Cantonese (they
  // read written Cantonese with Mandarin-ish pronunciation), so yue routes to
  // the v3 family — slower, but the only one that actually speaks it. Field
  // verdict pending (7/25 promise to the two guests).
  const model =
    targetLanguage === "yue"
      ? process.env.ELEVENLABS_YUE_MODEL?.trim() || "eleven_v3"
      : latency === "flash"
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

    // Tier 2 (lib/languages/catalog.ts): no engine wired up here can speak
    // this language. Sending the text anyway gets either a 502 or — worse —
    // confident audio in the wrong language's phonology, which a listener has
    // no way to recognize as a failure. Say what is true instead.
    //
    // /translate never reaches this: it asks canSpeak() before it calls, and
    // shows "text only" on the pill. This is the fence for everything that
    // doesn't ask — and it is deliberately narrow, firing only for a language
    // the catalog KNOWS it cannot speak. An unrecognized code keeps the old
    // pass-through behavior (default voice, no opinion) rather than becoming a
    // new way for an existing caller to start failing.
    if (isLanguageCode(body.targetLanguage) && !canSpeak(body.targetLanguage)) {
      return NextResponse.json(
        { error: "This language is text only.", textOnly: true },
        { status: 422 }
      );
    }

    // Wrong or absent code -> locked -> default voice. Deliberately silent:
    // a stranger gets working audio and no sign the clones exist.
    const unlocked = personalVoiceUnlocked(
      req.headers.get(PERSONAL_VOICE_HEADER),
      process.env.TAOS_PERSONAL_VOICE_CODE
    );

    // `await` (not a bare returned promise) so a thrown timeout lands in the
    // catch below rather than escaping the handler as a generic 500.
    return engine === "openai"
      ? await openai(text)
      : await elevenLabs(text, unlocked, body.sourceLanguage, body.targetLanguage, latency, voice);
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
