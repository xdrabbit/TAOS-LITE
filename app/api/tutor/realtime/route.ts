import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import { tutorEnabled } from "@/lib/release";
import { isLanguageCode } from "@/lib/languages/catalog";
import { buildTutorInstructions } from "@/lib/tutor/instructions";
import { getTutorModule } from "@/lib/tutor/modules";
import { lessonCacheKey } from "@/lib/tutor/lesson";
import { readCachedLesson } from "@/lib/tutor/lessonStore";
import {
  beginTutorSession,
  settleTutorSession,
  TutorMeterUnavailableError,
  TUTOR_WARN_SECONDS,
  type TutorBalance
} from "@/lib/tutor/meter";
import { toTutorLevel, toTutorPhase } from "@/lib/tutor/types";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * The balance, as the browser is allowed to see it.
 *
 * `-1` rather than `Infinity` for founders and comp: JSON has no infinity, and
 * `null` there would be indistinguishable from "we could not work it out",
 * which is exactly the ambiguity that makes a UI show a plausible wrong
 * number. lib/tutor/meterCopy.ts reads -1 as unlimited.
 */
function balancePayload(balance: TutorBalance): Record<string, unknown> {
  return {
    unlimited: balance.unlimited,
    tier: balance.tier,
    period: balance.period,
    remainingSeconds: balance.unlimited ? -1 : balance.remainingSeconds,
    planSeconds: Number.isFinite(balance.planSeconds) ? balance.planSeconds : -1,
    planLeft: Number.isFinite(balance.planLeft) ? balance.planLeft : -1,
    packSeconds: balance.packSeconds
  };
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

  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Please sign in to use the tutor." }, { status: 401 });
  }

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

  // ── The cash register ────────────────────────────────────────────────────
  // Phase 1 had the tier check inline here, with a note saying phase 2 would
  // move it behind lib/tutor/meter.ts so Walk, Run and Partner could not grow
  // three copies of the rule. This is that move: one call, which reads the
  // balance, refuses when it cannot fund a session, and RESERVES what it grants
  // so a second tab cannot spend the same minutes.
  //
  // It runs after the body is parsed (a 400 should not burn a reservation) and
  // before the mint (a refusal must cost nothing). The requested cap is the
  // client's — it is a ceiling the browser asks for, never a floor, and the
  // grant below is what actually governs.
  const requested =
    typeof body.capSeconds === "number" && Number.isFinite(body.capSeconds)
      ? Math.min(60 * 60, Math.max(0, Math.round(body.capSeconds)))
      : 10 * 60;

  let reservation;
  try {
    reservation = await beginTutorSession({
      user: { id: user.id, email: user.email },
      phase,
      requestedSeconds: requested,
      moduleId: mod?.id ?? null,
      target: pair.target,
      learner: pair.learner,
      level,
      model,
      focus: focus || null
    });
  } catch (error) {
    if (error instanceof TutorMeterUnavailableError) {
      // Production without the service-role key. Refusing is the only honest
      // answer: minting here would be an unmetered realtime session on the
      // exact deploy that opened the tutor to customers.
      // eslint-disable-next-line no-console
      console.error(error.message);
      return NextResponse.json(
        { error: "Tutor is temporarily unavailable.", details: "metering_unavailable" },
        { status: 503 }
      );
    }
    throw error;
  }

  if (!reservation.ok) {
    return NextResponse.json(
      {
        error: "quota_exhausted",
        details:
          reservation.balance.tier === "free"
            ? "Your free tutor minutes for this month are used up."
            : "You've used this month's tutor minutes.",
        balance: balancePayload(reservation.balance)
      },
      { status: 402 }
    );
  }

  const { sessionId, grantedSeconds } = reservation;

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

  // A reservation that is never settled holds its full grant until the reaper
  // collects it, which for a mint that never happened would lock a free user
  // out of ten of their fifteen minutes for two minutes at a time. Every exit
  // below this point releases it.
  const release = async (reason: "error") => {
    await settleTutorSession({
      user: { id: user.id, email: user.email },
      sessionId,
      serverSeconds: 0,
      reason,
      phase,
      moduleId: mod?.id ?? null
    }).catch(() => undefined);
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
      await release("error");
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
      await release("error");
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
      expiresAt,
      // What the meter actually granted. The client caps the session to this
      // (not to its own preferred 10 minutes), warns this many seconds BEFORE
      // the end, and shows the remainder in the header chip.
      grantedSeconds,
      warnLeadSeconds: TUTOR_WARN_SECONDS,
      balance: balancePayload(reservation.balance)
    });
  } catch (error) {
    await release("error");
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: "Realtime session error.", details: message }, { status: 502 });
  }
}
