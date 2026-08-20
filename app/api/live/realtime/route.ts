import { NextRequest, NextResponse } from "next/server";
import { buildInterpreterInstructions } from "@/lib/live/instructions";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";

export const runtime = "nodejs";
export const maxDuration = 30;

// Mints an ephemeral client secret for the /live "Ambient AI" mode: a GA
// Realtime session that listens to ambient conversation (dinner, TV, movie —
// any language, any number of voices) and speaks/writes ultra-short micro-
// summaries in the target language. Same GA endpoints as the tutor
// (app/api/tutor/realtime); unauthenticated to match the rest of the /live
// surface (/api/live-translate, /api/tts) — cost is bounded client-side by the
// session cap + idle auto-off in lib/live/ambient.ts.

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

  // Unknown codes fall back to the pair this app started life on rather than
  // reaching the prompt raw: an interpreter told its output language is "xx"
  // answers in whatever it likes, which is worse than answering in English.
  const body = (await req.json().catch(() => ({}))) as { target?: string; source?: string };
  const target =
    typeof body.target === "string" && isSupportedLanguageCode(body.target) ? body.target : "en";
  const rawSource =
    typeof body.source === "string" && isSupportedLanguageCode(body.source) ? body.source : "es";
  // A pair of one repeated language would ask the model to interpret a
  // language into itself; keep the two sides distinct the way the pair rule
  // does (lib/translate/pair.ts).
  const source = rawSource === target ? (target === "en" ? "es" : "en") : rawSource;

  // Full gpt-realtime: the mini tier drifted off-topic and hallucinated into
  // silence at the 7/8 field test. Costs roughly 3x mini (~$1-2/hr of dense
  // speech) — set OPENAI_LIVE_REALTIME_MODEL=gpt-realtime-mini to go back. Do
  // NOT reuse OPENAI_REALTIME_MODEL — that env holds the old translation-only
  // model (see app/api/tutor/realtime).
  const model = process.env.OPENAI_LIVE_REALTIME_MODEL?.trim() || "gpt-realtime";
  const voice = process.env.OPENAI_LIVE_REALTIME_VOICE?.trim() || "marin";
  const transcribeModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";

  const instructions = buildInterpreterInstructions(target, source);

  const session: Record<string, unknown> = {
    type: "realtime",
    model,
    instructions,
    output_modalities: ["audio"],
    // Keep every summary clipped even if the prompt is ignored — a long
    // response is a stale response.
    max_output_tokens: 120,
    audio: {
      input: {
        // Input transcription lets the UI show a faint "heard: …" line so the
        // user can sanity-check what the mic actually picked up.
        transcription: { model: transcribeModel },
        turn_detection: {
          type: "server_vad",
          // 0.6: fewer false triggers from clinks/coughs/room noise — those
          // committed empty turns and fed the hallucination problem.
          threshold: 0.6,
          prefix_padding_ms: 300,
          // 600ms: 450 chopped speech into fragments and the summaries came
          // out disjointed. Still snappier than the tutor's 700ms.
          silence_duration_ms: 600,
          // The CLIENT creates responses (lib/live/ambient.ts): auto-created
          // responses fired at every VAD pause and their audio overlapped when
          // people talked fast. The client waits until the previous summary
          // finishes playing, coalescing everything said meanwhile into one
          // fresh summary — freshness by design.
          create_response: false,
          // Never cancel a summary mid-word because someone kept talking
          // (which is always, at a dinner).
          interrupt_response: false
        }
      },
      // Slightly fast delivery keeps the earpiece current.
      output: { voice, speed: 1.15 }
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
        { error: "Failed to mint live session.", details: detail },
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
      target,
      source
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: "Live session error.", details: message }, { status: 502 });
  }
}
