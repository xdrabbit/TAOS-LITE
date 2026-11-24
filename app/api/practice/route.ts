import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { guardSpend, hit } from "@/lib/spendGuard";
import { isFounder, practiceEnabled } from "@/lib/release";
import { isLanguageCode, languageLabel } from "@/lib/languages/catalog";
import { transcribeAudio } from "@/lib/translate/transcribe";
import { getOpenAIKey } from "@/lib/translateProvider";
import { toTutorLevel } from "@/lib/tutor/types";
import {
  MAX_TURN_CHARS,
  PRACTICE_REPLY_SCHEMA,
  buildPracticeSystem,
  parsePracticeReply,
  sanitizeHistory,
  scenarioById,
  toClaudeMessages,
  type PracticeReply
} from "@/lib/practice/practice";

// POST /api/practice — one turn of Practice with Claude (lib/practice/practice.ts).
//
// In:  multipart form. `payload` is JSON { target, learner, scenario, level,
//      history, text? }; `audio` is the learner's recorded line, optional.
//      No audio and no text, with an empty history, is the scene's opening.
// Out: { heard, reply, translation, tip } — `heard` is what the learner said
//      (the transcript, or their typed text), the rest is lib/practice's
//      PracticeReply. The screen speaks `reply` itself through /api/tts, the
//      same as every other screen, so this route never touches a voice.
//
// The door, in order — the same shape as the other money routes:
//   1. the flag     NEXT_PUBLIC_ENABLE_PRACTICE off → 404 before anything else
//   2. guardSpend   no session → 401 (lib/spendGuard.ts, unweakened)
//   3. the key      no ANTHROPIC_API_KEY → 503 { configured: false }
//   4. a per-person turn limit, so one open tab cannot run up a bill
//
// The diagnostic line carries lengths and codes only — NEVER what anyone said.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // under Vercel's 4.5 MB body limit
const TRANSCRIBE_TIMEOUT_MS = 30_000;
const CLAUDE_TIMEOUT_MS = 40_000;

/** The latest Claude model; overridable without a deploy of new code. */
function practiceModel(): string {
  return process.env.TAOS_PRACTICE_MODEL?.trim() || "claude-opus-5-5";
}

function numberFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Per person, per instance — the same honest caveats as spendGuard's own
// limiter (per instance, reset on a cold start). A practice turn is one
// transcription and one short reply, a few cents at most; these bound a stuck
// loop or a script, not a keen learner. Founders skip them.
const TURNS_PER_MINUTE = numberFromEnv("TAOS_PRACTICE_TURNS_PER_MINUTE", 12);
const TURNS_PER_HOUR = numberFromEnv("TAOS_PRACTICE_TURNS_PER_HOUR", 150);
const minuteBuckets = new Map<string, { count: number; resetAt: number }>();
const hourBuckets = new Map<string, { count: number; resetAt: number }>();

const NOT_SET_UP = "Practice isn't set up yet. · La práctica aún no está lista.";
const SLOW_DOWN = "That's a lot of practice — take a breath and try again in a minute. · Mucha práctica: espera un minuto y vuelve a intentarlo.";
const NOT_HEARD = "I didn't catch that — try again a little closer to the mic. · No te escuché bien; inténtalo otra vez más cerca del micrófono.";
const TRY_AGAIN = "Something went wrong — please try that again. · Algo falló; inténtalo de nuevo.";

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

interface Timing {
  err: string;
  http: number;
  audioBytes: number;
  heardChars: number;
  replyChars: number;
  historyTurns: number;
  transcribeMs: number | "?";
  claudeMs: number | "?";
  inTok: number | "?";
  outTok: number | "?";
  cacheRead: number | "?";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const t: Timing = {
    err: "?",
    http: 500,
    audioBytes: 0,
    heardChars: 0,
    replyChars: 0,
    historyTurns: 0,
    transcribeMs: "?",
    claudeMs: "?",
    inTok: "?",
    outTok: "?",
    cacheRead: "?"
  };
  const started = performance.now();
  let res: NextResponse | undefined;
  try {
    res = await handle(req, t);
    return res;
  } finally {
    t.http = res?.status ?? 500;
    if (t.http < 300) t.err = "ok";
    console.log(
      `[taos-practice] http=${t.http} err=${t.err} audio=${t.audioBytes} heard=${t.heardChars} reply=${t.replyChars} hist=${t.historyTurns} transcribeMs=${t.transcribeMs} claudeMs=${t.claudeMs} in=${t.inTok} out=${t.outTok} cacheRead=${t.cacheRead} totalMs=${Math.round(performance.now() - started)}`
    );
  }
}

async function handle(req: NextRequest, t: Timing): Promise<NextResponse> {
  if (!practiceEnabled()) {
    t.err = "flag_off";
    return json({ error: "Not found." }, 404);
  }
  const guard = await guardSpend(req);
  if (!guard.ok) {
    t.err = "guard_blocked";
    return guard.response;
  }
  const user = guard.user;
  if (!user) {
    t.err = "no_user";
    return json({ error: "Please sign in to use this feature." }, 401);
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!anthropicKey) {
    t.err = "missing_anthropic_key";
    return json({ configured: false, error: NOT_SET_UP }, 503);
  }

  if (!isFounder(user.email)) {
    const now = Date.now();
    if (
      !hit(minuteBuckets, user.id, TURNS_PER_MINUTE, 60_000, now) ||
      !hit(hourBuckets, user.id, TURNS_PER_HOUR, 3_600_000, now)
    ) {
      t.err = "rate_limited";
      return json({ error: SLOW_DOWN }, 429);
    }
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    t.err = "bad_form";
    return json({ error: TRY_AGAIN }, 400);
  }
  let payload: Record<string, unknown> = {};
  try {
    const raw = form.get("payload");
    payload = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    t.err = "bad_payload";
    return json({ error: TRY_AGAIN }, 400);
  }

  const target = isLanguageCode(payload.target) ? payload.target : "es";
  const learner = isLanguageCode(payload.learner) ? payload.learner : "en";
  const scenario = scenarioById(payload.scenario);
  const level = toTutorLevel(payload.level);
  const history = sanitizeHistory(payload.history);
  t.historyTurns = history.length;

  // What the learner said this turn: typed text wins, else the recording.
  let heard = typeof payload.text === "string" ? payload.text.trim().slice(0, MAX_TURN_CHARS) : "";
  const audio = form.get("audio");
  if (!heard && audio instanceof File && audio.size > 0) {
    t.audioBytes = audio.size;
    if (audio.size > MAX_AUDIO_BYTES) {
      t.err = "audio_too_big";
      return json({ error: NOT_HEARD }, 413);
    }
    const openAiKey = getOpenAIKey();
    if (!openAiKey) {
      t.err = "missing_openai_key";
      return json({ configured: false, error: NOT_SET_UP }, 503);
    }
    const t0 = performance.now();
    try {
      // No language hint: a stuck learner switches back to their own
      // language, and the prompt is written to catch exactly that.
      heard = await transcribeAudio(openAiKey, audio, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
    } catch {
      t.err = "transcribe_failed";
      return json({ error: TRY_AGAIN }, 502);
    } finally {
      t.transcribeMs = Math.round(performance.now() - t0);
    }
    heard = heard.slice(0, MAX_TURN_CHARS);
    if (!heard) {
      t.err = "nothing_heard";
      return json({ error: NOT_HEARD }, 422);
    }
  }
  t.heardChars = heard.length;

  // Nothing said and nothing yet in the thread is the opening; nothing said
  // in a thread that has started is a turn with nothing to answer.
  if (!heard && history.length > 0) {
    t.err = "empty_turn";
    return json({ error: NOT_HEARD }, 422);
  }

  const system = buildPracticeSystem({
    targetName: languageLabel(target),
    learnerName: languageLabel(learner),
    scenario,
    level
  });

  const client = new Anthropic({ apiKey: anthropicKey, timeout: CLAUDE_TIMEOUT_MS, maxRetries: 1 });
  const t1 = performance.now();
  let reply: PracticeReply | null = null;
  try {
    const message = await client.beta.messages.create({
      model: practiceModel(),
      // Thinking is always on for this model; low effort keeps a chat turn
      // quick. The room above the short JSON reply is for that thinking.
      max_tokens: 4000,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: PRACTICE_REPLY_SCHEMA }
      },
      // The system prompt is fixed for the whole scene and the history only
      // ever grows at the end, so each turn re-reads a cached prefix.
      cache_control: { type: "ephemeral" },
      // A safety decline is retried on another model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: toClaudeMessages(history, heard)
    });
    t.inTok = message.usage.input_tokens;
    t.outTok = message.usage.output_tokens;
    t.cacheRead = message.usage.cache_read_input_tokens ?? 0;
    if (message.stop_reason === "refusal") {
      t.err = "refusal";
      return json({ error: TRY_AGAIN, heard }, 502);
    }
    for (const block of message.content) {
      if (block.type === "text") {
        reply = parsePracticeReply(block.text);
        if (reply) break;
      }
    }
  } catch (e) {
    t.err =
      e instanceof Anthropic.RateLimitError
        ? "claude_429"
        : e instanceof Anthropic.APIConnectionTimeoutError
          ? "claude_timeout"
          : e instanceof Anthropic.APIError
            ? `claude_${e.status ?? "err"}`
            : "claude_failed";
    return json({ error: TRY_AGAIN, heard }, 502);
  } finally {
    t.claudeMs = Math.round(performance.now() - t1);
  }

  if (!reply) {
    t.err = "bad_reply";
    return json({ error: TRY_AGAIN, heard }, 502);
  }
  t.replyChars = reply.reply.length;
  return json({ heard, ...reply });
}
