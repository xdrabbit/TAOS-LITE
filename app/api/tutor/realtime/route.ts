import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { tutorEnabled } from "@/lib/release";
import { isLanguageCode } from "@/lib/languages/catalog";
import { buildTutorInstructions } from "@/lib/tutor/instructions";
import { getTutorModule } from "@/lib/tutor/modules";
import { lessonCacheKey } from "@/lib/tutor/lesson";
import { readCachedLesson } from "@/lib/tutor/lessonStore";
import { logTutorSessionEvent, newTutorSessionId } from "@/lib/tutor/meter";
import { toTutorLevel, toTutorPhase } from "@/lib/tutor/types";

export const runtime = "nodejs";
export const maxDuration = 30;

// Monthly tutor-minute quota per tier — enforced here so a user can't bypass the
// UI cap and run unlimited (expensive) realtime minutes. Mirror of lib/supabase.
const TUTOR_SECONDS_BY_TIER: Record<string, number> = {
  free: 15 * 60,
  basic: 45 * 60,
  premium: 200 * 60
};

function startOfMonthISO(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function monthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Returns an error response if the caller has used up this month's tutor minutes
// for their tier; otherwise the caller's user id (allowed). Comp/unlimited pass.
//
// Phase 2 (docs/tutor-curriculum-plan.md step 5) moves this behind
// lib/tutor/meter.ts, so Walk, Run and Partner cannot grow three copies of the
// allowance rule between them. It stays here meanwhile because it is the only
// thing standing between a flag flip and an unmetered realtime session.
async function checkTutorAllowance(
  req: NextRequest
): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Please sign in to use the tutor." }, { status: 401 })
    };
  }
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("subscription_status, tier, bonus_seconds, bonus_period")
    .eq("id", user.id)
    .maybeSingle();
  const status = (profile?.subscription_status as string | undefined) ?? "free";
  if (status === "comp") return { ok: true, userId: user.id }; // unlimited

  // Effective tier: active subscribers use their tier; everyone else is free.
  const tier =
    status === "active"
      ? (profile?.tier as string | undefined) === "premium"
        ? "premium"
        : "basic"
      : "free";
  // Monthly quota + any add-on pack minutes bought this month.
  const bonus =
    (profile?.bonus_period as string | undefined) === monthKey()
      ? ((profile?.bonus_seconds as number | undefined) ?? 0)
      : 0;
  const cap = (TUTOR_SECONDS_BY_TIER[tier] ?? TUTOR_SECONDS_BY_TIER.free) + bonus;

  const { data: rows } = await supabaseAdmin
    .from("tutor_sessions")
    .select("seconds")
    .eq("user_id", user.id)
    .eq("mode", "conversation")
    .gte("created_at", startOfMonthISO());
  const used = ((rows ?? []) as Array<{ seconds?: number | null }>).reduce(
    (a, r) => a + (typeof r.seconds === "number" ? r.seconds : 0),
    0
  );
  if (used >= cap) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "quota_exhausted",
          details:
            tier === "free"
              ? "Your free tutor minutes for this month are used up."
              : "You've used this month's tutor minutes. Upgrade for more."
        },
        { status: 402 }
      )
    };
  }
  return { ok: true, userId: user.id };
}

// GA Realtime endpoints. Overridable via env in case OpenAI moves them.
const CLIENT_SECRETS_URL =
  process.env.OPENAI_REALTIME_CLIENT_SECRETS_URL ??
  "https://api.openai.com/v1/realtime/client_secrets";
const CALLS_URL =
  process.env.OPENAI_REALTIME_CALLS_URL ?? "https://api.openai.com/v1/realtime/calls";

/**
 * The language pair for this session.
 *
 * `target` is what the learner is learning; `learner` is what they already
 * speak. Both are catalog codes (lib/languages/catalog.ts) — this route used
 * to carry `type LearnLang = "es" | "en"` and pick the two language NAMES off
 * a ternary, which is the ceiling docs/tutor-curriculum-plan.md step 4 exists
 * to remove and the same bug that had /call interpreting into the wrong
 * language on a trip.
 *
 * The legacy `{ learn: "es" | "en" }` body still works: it is what an old
 * client bundle sends, and answering it with a 400 would break a phone that
 * has not reloaded rather than teach it anything.
 */
function resolvePair(body: { target?: string; learner?: string; learn?: string }): {
  target: string;
  learner: string;
} | null {
  const target = String(body.target ?? "");
  const learner = String(body.learner ?? "");
  if (isLanguageCode(target) && isLanguageCode(learner) && target !== learner) {
    return { target, learner };
  }
  if (body.learn === "es" || body.learn === "en") {
    return { target: body.learn, learner: body.learn === "es" ? "en" : "es" };
  }
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // RC1: tutor is off (lib/release.ts). The page redirects home, but the API
  // is reachable on its own — and this one mints a paid OpenAI realtime
  // session. A disabled feature should cost nothing, so answer as if the
  // route did not exist.
  if (!tutorEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  // Enforce the monthly minute cap before spending on a realtime session.
  const allowance = await checkTutorAllowance(req);
  if (!allowance.ok) return allowance.response;

  const body = (await req.json().catch(() => ({}))) as {
    target?: string;
    learner?: string;
    learn?: string;
    level?: string;
    focus?: string;
    phase?: string;
    moduleId?: string;
    capSeconds?: number;
  };

  const pair = resolvePair(body);
  if (!pair) {
    return NextResponse.json({ error: "Unsupported language pair." }, { status: 400 });
  }
  const level = toTutorLevel(body.level);
  const phase = toTutorPhase(body.phase);
  const focus = typeof body.focus === "string" ? body.focus.slice(0, 200).trim() : "";
  const mod = getTutorModule(String(body.moduleId ?? ""));

  // Walk needs the lesson's script and Run wants its phrase list. The lesson
  // is read from the CACHE rather than accepted from the request body: the
  // browser has it already, but a persona assembled from whatever the client
  // posted is a prompt-injection surface on a route that mints a paid session.
  // A cache miss is not an error — the module alone still makes a usable
  // scene (lib/tutor/instructions.ts), it is just less specific.
  const lesson =
    mod && (phase === "walk" || phase === "run")
      ? (await readCachedLesson(lessonCacheKey(mod.id, pair.target, pair.learner)))?.lesson
      : undefined;

  // IMPORTANT: do NOT fall back to OPENAI_REALTIME_MODEL — that env is set to
  // the translation-only model (gpt-realtime-translate) left over from the old
  // realtime translator, which can't hold a conversation (it 404s on
  // inference_stream). The tutor needs a conversational speech-to-speech model.
  const model = process.env.OPENAI_TUTOR_REALTIME_MODEL?.trim() || "gpt-realtime-mini";
  const voice = process.env.OPENAI_REALTIME_VOICE?.trim() || "marin";
  const transcribeModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";

  const instructions = buildTutorInstructions({
    target: pair.target,
    learner: pair.learner,
    level,
    phase,
    module: mod,
    lesson,
    focus: focus || undefined
  });

  const session: Record<string, unknown> = {
    type: "realtime",
    model,
    instructions,
    // REQUIRED for spoken replies. Without this the model only transcribes the
    // learner and never talks back (it defaults to text-only for some models).
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: transcribeModel },
        // Server VAD = hands-free: the tutor auto-replies when the learner stops
        // talking. ~700ms of silence ends a turn; create_response makes the
        // model answer each turn without an explicit response.create.
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
          create_response: true,
          interrupt_response: true
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

    // The metering seam (lib/tutor/meter.ts). Emitted only once the session
    // actually exists — a start line for a mint that failed would overstate
    // every cost report built on this log.
    const sessionId = newTutorSessionId();
    logTutorSessionEvent({
      event: "start",
      sessionId,
      userId: allowance.userId,
      phase,
      moduleId: mod?.id ?? null,
      target: pair.target,
      learner: pair.learner,
      level,
      model,
      capSeconds: typeof body.capSeconds === "number" ? Math.round(body.capSeconds) : undefined
    });

    return NextResponse.json({
      sessionId,
      clientSecret,
      callUrl: `${CALLS_URL}?model=${encodeURIComponent(model)}`,
      model,
      voice,
      target: pair.target,
      learner: pair.learner,
      // Kept so an un-reloaded client bundle still reads a field it knows.
      learn: pair.target,
      level,
      phase,
      moduleId: mod?.id ?? null,
      lessonAvailable: Boolean(lesson),
      focus,
      instructions,
      expiresAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: "Realtime session error.", details: message }, { status: 502 });
  }
}
