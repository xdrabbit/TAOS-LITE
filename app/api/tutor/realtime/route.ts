import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// GA Realtime endpoints. Overridable via env in case OpenAI moves them.
const CLIENT_SECRETS_URL =
  process.env.OPENAI_REALTIME_CLIENT_SECRETS_URL ??
  "https://api.openai.com/v1/realtime/client_secrets";
const CALLS_URL =
  process.env.OPENAI_REALTIME_CALLS_URL ?? "https://api.openai.com/v1/realtime/calls";

type LearnLang = "es" | "en";
type Level = "beginner" | "intermediate" | "advanced";

// Build the steerable coach persona. `focus` lets the learner aim the chat at a
// topic ("kitchen words", "baseball"); steering mid-call is done client-side via
// session.update using this same string + accumulated directives.
function buildTutorInstructions(opts: {
  learn: LearnLang;
  level: Level;
  focus?: string;
}): string {
  const targetName = opts.learn === "es" ? "Spanish" : "English";
  const nativeName = opts.learn === "es" ? "English" : "Spanish";

  const levelLine =
    opts.level === "beginner"
      ? `The learner is a BEGINNER. Speak slowly with short, simple sentences; drop into ${nativeName} briefly when they're truly stuck, then return to ${targetName}.`
      : opts.level === "advanced"
        ? `The learner is ADVANCED. Speak naturally and at a normal pace in ${targetName}; correct even subtle errors of grammar, idiom, and accent.`
        : `The learner is INTERMEDIATE. Speak mostly in ${targetName} at a natural but clear pace.`;

  const focusLine = opts.focus
    ? `Center the conversation on this topic / vocabulary: ${opts.focus}.`
    : `Keep the conversation lively and varied — ask about their day, interests, food, plans, and surroundings.`;

  return [
    `You are TAOS Tutor, a warm, upbeat, but EXACTING ${targetName} conversation and pronunciation coach.`,
    `Your student is a native ${nativeName} speaker learning ${targetName}.`,
    levelLine,
    `Hold a natural back-and-forth conversation. Keep YOUR turns short (1-3 sentences) so the student does most of the talking.`,
    `Be a stickler about pronunciation and grammar: the moment the student makes a meaningful mistake, kindly correct it — say the correct version clearly, have them repeat it once, then move on. Don't let errors slide, but never lecture.`,
    `Always end your turn with a simple question so they keep talking.`,
    focusLine,
    `If the student gives a meta-instruction (e.g. "use more English", "slower", "let's talk about kitchens" or "baseball"), follow it immediately and from then on.`,
    `Never break character or say you are an AI. Stay encouraging, patient, and a little playful.`
  ].join(" ");
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    learn?: string;
    level?: string;
    focus?: string;
  };
  const learn: LearnLang = body.learn === "en" ? "en" : "es";
  const level: Level =
    body.level === "beginner" ? "beginner" : body.level === "advanced" ? "advanced" : "intermediate";
  const focus = typeof body.focus === "string" ? body.focus.slice(0, 200).trim() : "";

  const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-mini";
  const voice = process.env.OPENAI_REALTIME_VOICE?.trim() || "marin";
  const transcribeModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";

  const instructions = buildTutorInstructions({ learn, level, focus: focus || undefined });

  const session: Record<string, unknown> = {
    type: "realtime",
    model,
    instructions,
    audio: {
      input: {
        transcription: { model: transcribeModel },
        // Server VAD = hands-free: the tutor replies when the learner stops
        // talking. ~700ms of silence ends a turn.
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700
        }
      },
      output: { voice }
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
        { error: "Failed to mint realtime session.", details: detail },
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
    const expiresAt =
      (typeof payload?.expires_at === "number" && payload.expires_at) ||
      (nested && typeof nested.expires_at === "number" && nested.expires_at) ||
      undefined;

    return NextResponse.json({
      clientSecret,
      callUrl: `${CALLS_URL}?model=${encodeURIComponent(model)}`,
      model,
      voice,
      learn,
      level,
      focus,
      instructions,
      expiresAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: "Realtime session error.", details: message }, { status: 502 });
  }
}
