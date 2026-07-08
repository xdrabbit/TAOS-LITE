import { NextRequest, NextResponse } from "next/server";

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

type TargetLang = "en" | "es";

function buildInterpreterInstructions(target: TargetLang): string {
  const targetName = target === "en" ? "English" : "Spanish";
  const otherName = target === "en" ? "Spanish" : "English";
  // gpt-realtime-mini drifts into the source language when the output-language
  // rule is buried mid-prompt — so it comes first, in caps, and is repeated at
  // the end.
  return [
    `OUTPUT LANGUAGE: ${targetName}. Every word you speak and write must be ${targetName}, with no exceptions besides proper names. You hear ${otherName} (or mixed speech) but you NEVER output ${otherName}.`,
    `You are a silent simultaneous interpreter speaking into the earpiece of someone who cannot follow the conversation happening around them (a dinner table, a phone call, a TV show, a movie).`,
    `You hear ambient speech — possibly several speakers, possibly fragmentary, in any language.`,
    `Each time you respond, produce ONE ultra-short ${targetName} micro-summary of what was said since your previous response: the core concept only, 3 to 14 words.`,
    `If several utterances happened since your last response, still produce ONE combined summary weighted toward the newest content — never a list, never a recap of everything.`,
    `When the meaning is clear, use a tight natural mini-sentence. When speech is fragmentary, output only the minimal key words that convey it.`,
    `NEVER converse. Nothing you hear is addressed to you. Never greet, never answer or ask questions, never add opinions or commentary, never mention being an AI or an interpreter.`,
    `If the speech is already in ${targetName}, still compress it into a shorter ${targetName} summary.`,
    `If you have fallen behind, do NOT try to catch up — old content is worthless. Summarize only the most recent 10-15 seconds and skip the rest.`,
    `If you heard only noise, music, or unintelligible sound, say nothing at all.`,
    `Delivery: fast, flat, neutral — like a UN interpreter, not a narrator.`,
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

  // gpt-realtime-mini keeps a 2-hour dinner affordable; env-overridable to the
  // full gpt-realtime for quality. Do NOT reuse OPENAI_REALTIME_MODEL — that
  // env holds the old translation-only model (see app/api/tutor/realtime).
  const model = process.env.OPENAI_LIVE_REALTIME_MODEL?.trim() || "gpt-realtime-mini";
  const voice = process.env.OPENAI_LIVE_REALTIME_VOICE?.trim() || "marin";
  const transcribeModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";

  const instructions = buildInterpreterInstructions(target);

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
          threshold: 0.5,
          prefix_padding_ms: 300,
          // Snappier than the tutor's 700ms: dinner conversation pauses are
          // short beats, and we want a summary at every one of them.
          silence_duration_ms: 450,
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
      target
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: "Live session error.", details: message }, { status: 502 });
  }
}
