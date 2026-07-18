import { NextRequest, NextResponse } from "next/server";
import { buildTurnInstructions, type TabletopDirection } from "@/lib/tabletop/instructions";

export const runtime = "nodejs";
export const maxDuration = 30;

// Mints an ephemeral client secret for /tabletop "live" mode: a GA Realtime
// session that translates one push-to-talk turn AS THE PERSON SPEAKS. Output
// is TEXT ONLY (streams onto the listener's pane; much cheaper than audio
// output) — the spoken readout happens at turn end via /api/tts with the
// cloned voices. The session outlives turns: the client swaps direction
// per turn with session.update and detaches the mic track between turns so
// idle table time doesn't stream (or bill) silence.

const CLIENT_SECRETS_URL =
  process.env.OPENAI_REALTIME_CLIENT_SECRETS_URL ??
  "https://api.openai.com/v1/realtime/client_secrets";
const CALLS_URL =
  process.env.OPENAI_REALTIME_CALLS_URL ?? "https://api.openai.com/v1/realtime/calls";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { direction?: string };
  const direction: TabletopDirection = body.direction === "es-en" ? "es-en" : "en-es";

  // Same model policy as /live and /call: full gpt-realtime (mini drifted at
  // the 7/8 field test). Reuses the /live override env, plus its own.
  const model =
    process.env.OPENAI_TABLETOP_REALTIME_MODEL?.trim() ||
    process.env.OPENAI_LIVE_REALTIME_MODEL?.trim() ||
    "gpt-realtime";
  const transcribeModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";

  const session: Record<string, unknown> = {
    type: "realtime",
    model,
    instructions: buildTurnInstructions(direction),
    // TEXT ONLY: the streamed translation is read off the pane; audio readout
    // happens at turn end via /api/tts (cloned voices, party-volume mp3).
    output_modalities: ["text"],
    // One VAD segment's translation — segments are phrase-sized.
    max_output_tokens: 300,
    audio: {
      input: {
        // The speaker's own pane shows the running "heard" transcript.
        transcription: { model: transcribeModel },
        turn_detection: {
          type: "server_vad",
          // Party room: high threshold so clinks and crowd noise don't commit
          // empty segments (the /live hallucination lesson).
          threshold: 0.6,
          prefix_padding_ms: 300,
          // Phrase-sized chunks: snappy enough to feel live, long enough to
          // carry meaning.
          silence_duration_ms: 550,
          // Text responses can't overlap like audio, so server-created
          // responses per VAD segment are safe here (unlike /live and /call).
          create_response: true,
          interrupt_response: false
        }
      }
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
        { error: "Failed to mint tabletop session.", details: detail },
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
      direction
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json(
      { error: "Tabletop session error.", details: message },
      { status: 502 }
    );
  }
}
