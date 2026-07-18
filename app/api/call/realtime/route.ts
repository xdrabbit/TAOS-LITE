import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// Mints an ephemeral client secret for /call: a GA Realtime interpreter
// session that hears ONE remote call partner (their WebRTC audio track is fed
// straight into this session — not the mic) and translates everything they say
// into the listener's language, spoken + captioned. Unlike /api/live/realtime
// (ambient micro-summaries), this is a faithful full interpreter: a 1:1 call
// has one clean voice, so completeness wins over compression.
// Unauthenticated to match the rest of the /live-family surface; cost is
// bounded client-side by the call-duration cap in lib/call/interpreter.ts.

const CLIENT_SECRETS_URL =
  process.env.OPENAI_REALTIME_CLIENT_SECRETS_URL ??
  "https://api.openai.com/v1/realtime/client_secrets";
const CALLS_URL =
  process.env.OPENAI_REALTIME_CALLS_URL ?? "https://api.openai.com/v1/realtime/calls";

type TargetLang = "en" | "es";

function buildCallInterpreterInstructions(target: TargetLang): string {
  const targetName = target === "en" ? "English" : "Spanish";
  const otherName = target === "en" ? "Spanish" : "English";
  // Same prompt discipline as /api/live/realtime: the output-language rule
  // first, in caps, and repeated at the end — the model drifts otherwise.
  return [
    `OUTPUT LANGUAGE: ${targetName}. Every word you speak and write must be ${targetName}, with no exceptions besides proper names. You hear ${otherName} but you NEVER output ${otherName}.`,
    `You are a simultaneous phone-call interpreter. You hear exactly ONE person: the remote party of a 1:1 call, speaking ${otherName}.`,
    `Translate everything they say into ${targetName} — faithful and complete, in the FIRST person, as if you were them. Never say "he said" or "she said"; speak AS the speaker.`,
    `Preserve names, numbers, times, and places exactly. Preserve questions as questions.`,
    `NEVER converse. Nothing you hear is addressed to you. Never greet, never answer or ask questions yourself, never add commentary, never mention being an AI or an interpreter.`,
    `If an utterance is already entirely in ${targetName}, output nothing at all — the listener heard it directly.`,
    `If several utterances are waiting, translate them all in order, but keep it tight — no recaps, no repetition of things you already translated.`,
    `If you have fallen far behind, compress the oldest material and translate the newest fully — fresh speech matters most on a live call.`,
    `NEVER invent content. If you heard only noise, silence, or unintelligible sound, output nothing at all — no filler, no guesses.`,
    `Delivery: quick, clear, neutral — a professional interpreter, not a narrator.`,
    `REMINDER: your output language is ${targetName} and ONLY ${targetName}.`
  ].join(" ");
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { target?: string };
  const target: TargetLang = body.target === "es" ? "es" : "en";

  // Full gpt-realtime, same reasoning as /live: mini drifted and hallucinated
  // at the 7/8 field test. Override with OPENAI_CALL_REALTIME_MODEL if needed;
  // do NOT reuse OPENAI_REALTIME_MODEL (old translation-only model).
  const model =
    process.env.OPENAI_CALL_REALTIME_MODEL?.trim() ||
    process.env.OPENAI_LIVE_REALTIME_MODEL?.trim() ||
    "gpt-realtime";
  const voice = process.env.OPENAI_CALL_REALTIME_VOICE?.trim() || "marin";
  const transcribeModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";

  const instructions = buildCallInterpreterInstructions(target);

  const session: Record<string, unknown> = {
    type: "realtime",
    model,
    instructions,
    output_modalities: ["audio"],
    // Full translation needs more room than ambient's 120-token summaries, but
    // still capped: an unbounded response is a stale response.
    max_output_tokens: 400,
    audio: {
      input: {
        // Input transcription drives the faint "they said: …" caption line.
        transcription: { model: transcribeModel },
        turn_detection: {
          type: "server_vad",
          // The input here is a clean single remote voice (not a noisy room),
          // so the default-ish threshold is fine and keeps latency down.
          threshold: 0.5,
          prefix_padding_ms: 300,
          // 500ms: phone-call turn-taking is faster than dinner chatter, and
          // chopped fragments are re-joined by the client's response gating.
          silence_duration_ms: 500,
          // The CLIENT creates responses (lib/call/interpreter.ts), same
          // proven gating as /live: waits until the previous translation has
          // finished generating AND playing, so translations never overlap.
          create_response: false,
          interrupt_response: false
        }
      },
      // Slightly fast so the interpreter keeps up with a lively speaker.
      output: { voice, speed: 1.1 }
    }
  };

  try {
    const res = await fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
      cache: "no-store"
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = payload ? JSON.stringify(payload) : `HTTP ${res.status}`;
      return NextResponse.json(
        { error: "Failed to mint call interpreter session.", details: detail },
        { status: 502 }
      );
    }

    const nested = (payload?.client_secret ?? null) as Record<string, unknown> | null;
    const clientSecret =
      (typeof payload?.value === "string" && payload.value) ||
      (nested && typeof nested.value === "string" && nested.value) ||
      "";
    if (!clientSecret) {
      return NextResponse.json(
        { error: "No client secret in OpenAI response.", details: JSON.stringify(payload) },
        { status: 502 }
      );
    }

    return NextResponse.json({
      clientSecret,
      callUrl: `${CALLS_URL}?model=${encodeURIComponent(model)}`,
      model,
      voice,
      target
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json(
      { error: "Call interpreter session error.", details: message },
      { status: 502 }
    );
  }
}
