import { NextRequest, NextResponse } from "next/server";
import { isLanguageCode, type LanguageCode } from "@/lib/languages/catalog";
import { fastMicVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { transcribeAudio } from "@/lib/translate/transcribe";
import { checkFastRate } from "@/lib/fast/rateLimit";
import {
  dictationHintFor,
  FAST_MAX_DICTATION_BYTES
} from "@/lib/fast/dictation";

export const runtime = "nodejs";
// A quickie is a phrase, capped at FAST_MAX_DICTATION_MS (30s) in the browser,
// and this route does ONE thing with it. Sixty seconds is generous room for a
// thirty-second upload plus the transcription, and far below /api/translate's
// 300 — that ceiling is sized for a five-minute spoken turn, which is not what
// this is.
export const maxDuration = 60;

/**
 * How long to wait on the transcriber before giving up.
 *
 * Well under maxDuration, for the reason lib/translate/transcribe.ts records:
 * a stall that runs out the function's clock reaches the phone as Safari's
 * opaque "Load failed" instead of something retryable. Shorter than
 * /api/translate's 120s because the audio is 30 seconds, not five minutes.
 */
const LISTEN_TIMEOUT_MS = 45000;

// POST /api/fast/listen — audio in, transcript out. Nothing else.
//
// ── Why this is not just a call to /api/translate ──────────────────────────
// That route transcribes AND paraphrases, and /fast would throw the
// paraphrase away: the transcript belongs in the input box, where somebody can
// fix it before it means anything, and the translation is then produced by the
// screen's normal settled-input flow through POST /api/fast — the literal
// engine, not the house voice. Calling /api/translate here would buy a gpt-4.1
// completion per dictation, in the wrong register, to discard it. So this
// route shares that one's TRANSCRIBER (lib/translate/transcribe.ts, lifted out
// unchanged, fences and all) and stops there.
//
// ── PARKED, 2026-08-31 ─────────────────────────────────────────────────────
// The mic came off /fast (lib/release.ts), so this route answers 404 to
// everyone — founders included — until NEXT_PUBLIC_ENABLE_FAST_MIC=1. That is
// deliberate and not belt-and-braces: this is the route that buys a Whisper
// transcription, and a paid endpoint left open with no UI calling it is not a
// parked feature, it is an unwatched one. The gate below is the same flag that
// decides whether the button exists, so the two cannot drift apart.
//
// ── The gate and the meter are /api/fast's, deliberately ───────────────────
// fastMicVisibleTo() is fastVisibleTo() AND the mic flag, 404-not-403, so the
// mic cannot outlive the screen it is on — nor the decision that took it off
// that screen. Same checkFastRate() buckets, and that sharing is the point
// rather than
// an economy: a mic that had its own counter would be a second way to spend on
// /fast that the /fast ceiling could not see, and this is the more expensive
// of the two calls. Speaking is metered against the same minute as typing.
//
// ── What it does NOT do ────────────────────────────────────────────────────
// It does not write a taos_lite_translations row, which is the free monthly
// allowance (lib/supabase.ts, getMonthlyUsage). Dictating is not asking for a
// translation — it is putting words in a box. The row is still written when
// the input SETTLES, exactly as it is for typing, so one spoken quickie costs
// one allowance unit whether the words arrived from a keyboard or a mouth.
// lib/fast/settle.ts holds that rule.

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

function bad(message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/** The two languages on the pills, used only to decide the Cantonese hint. */
function readPair(form: FormData): LanguageCode[] {
  return ["pairA", "pairB"]
    .map((field) => String(form.get(field) ?? ""))
    .filter((code): code is LanguageCode => isLanguageCode(code));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Identity first, same order as POST /api/fast: founder-ness is the gate and
  // only a validated token can answer it. guardSpend touches Supabase, never a
  // paid provider, so a stranger's request stops here having cost nothing —
  // and here that matters more than it does next door, because the body it
  // would otherwise have read is an audio upload.
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!fastMicVisibleTo(email)) return notFound();
  if (!guard.ok) return guard.response;
  const userId = guard.user?.id ?? "unknown";

  // Before the upload is read. A refusal that first accepts two megabytes of
  // audio is not much of a refusal.
  const rate = checkFastRate(userId);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many in a row. Give it a moment.", window: rate.window },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "5" } }
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return bad("Server misconfiguration: missing OPENAI_API_KEY.", 500);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("Request body must be multipart form data.", 400);
  }

  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return bad("An audio recording is required.", 400);
  }
  if (audio.size > FAST_MAX_DICTATION_BYTES) {
    return bad("That recording is too long for a quickie. Type it, or keep it short.", 413);
  }

  try {
    // No source label: /fast dictates in auto-detect, because the box does not
    // know which of the two languages is about to be spoken. The pair is asked
    // only for the Cantonese hint (lib/fast/dictation.ts).
    const text = await transcribeAudio(apiKey, audio, {
      extraHint: dictationHintFor(readPair(form)),
      timeoutMs: LISTEN_TIMEOUT_MS
    });
    // "" is the transcriber saying there was no usable speech — a fumbled tap,
    // a muted mic, a pocket. Not an error, and the same bilingual line
    // /api/translate answers with, because it is the same situation.
    if (!text) {
      return NextResponse.json(
        { error: "Nothing was heard — try again. · No se escuchó nada — intenta de nuevo." },
        { status: 422, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json({ text }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const timedOut =
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut) {
      return NextResponse.json(
        { error: "Transcription took too long. Please try again." },
        { status: 504, headers: { "Cache-Control": "no-store" } }
      );
    }
    const details = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json(
      { error: "Transcription failed.", details },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
