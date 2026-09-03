import { NextRequest, NextResponse } from "next/server";
import type { CallDirection } from "@/lib/call/instructions";
import {
  buildCallSession,
  CALL_CONTEXT_TOKEN_LIMIT,
  CALL_SECRET_TTL_SECONDS
} from "@/lib/call/realtimeSession";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";
import { callVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";

export const runtime = "nodejs";
export const maxDuration = 30;

// Mints an ephemeral client secret for /call: a GA Realtime interpreter
// session that hears ONE remote call partner (their WebRTC audio track is fed
// straight into this session — not the mic) and translates everything they say
// into the listener's language. Unlike /api/live/realtime (ambient micro-
// summaries), this is a faithful full interpreter: a 1:1 call has one clean
// voice, so completeness wins over compression.
//
// ── Who may spend ──────────────────────────────────────────────────────────
// FOUNDERS ONLY, and this is the check that matters. The nav link and the
// page gate run in the browser off a session the client already holds, so
// they hide /call without defending it; this one re-asks callVisibleTo()
// against a server-validated access token. A stranger who renders CallShell
// by hand gets a 404 here and no session is ever minted.
//
// 404 rather than 403, and 404 rather than the 401 guardSpend would give a
// signed-out caller: to anyone who isn't a founder, this route does not
// exist. The one case that still gets a 401 is a founder whose token expired
// while /call was public — which cannot happen today and reads correctly if
// it ever does.
//
// ── Where the money goes ───────────────────────────────────────────────────
// Measured against a live session on 2026-08-27 (lib/call/cost.ts carries the
// table). In descending order of what a minute costs:
//   1. audio OUT, when the model speaks:  $64/Mtok, ~25 tok/s of speech.
//      "clone" mode asks for TEXT and sends it to /api/tts instead — the
//      app's own voices, which are both cheaper and Liz's actual voice.
//   2. re-reading the conversation:       audio at $32/Mtok, every response.
//      `truncation` below is the cap that makes this flat per turn instead
//      of linear in call length. It is the single largest saving here.
//   3. audio IN:                          $32/Mtok, but only the segments
//      server VAD commits — streamed silence is not billed, which is why
//      there is no client-side speech gate in lib/call/interpreter.ts.

const CLIENT_SECRETS_URL =
  process.env.OPENAI_REALTIME_CLIENT_SECRETS_URL ??
  "https://api.openai.com/v1/realtime/client_secrets";
const CALLS_URL =
  process.env.OPENAI_REALTIME_CALLS_URL ?? "https://api.openai.com/v1/realtime/calls";

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Identity first, because founder-ness is the gate and only a validated
  // token can answer it. guardSpend touches Supabase, never the paid
  // provider, so a stranger's request still costs nothing that shows up on a
  // bill — and it stops at the 404 below before OpenAI is called at all.
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!callVisibleTo(email)) return notFound();
  if (!guard.ok) return guard.response;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  // The two ends of the call, as catalog codes — `source` is what the remote
  // partner speaks, `target` is what this phone's owner hears. Unknown or
  // missing values fall back rather than reaching the prompt raw: an
  // interpreter told to output "xx" writes whatever it likes.
  const body = (await req.json().catch(() => ({}))) as {
    source?: string;
    target?: string;
    mode?: string;
  };
  const target =
    typeof body.target === "string" && isSupportedLanguageCode(body.target) ? body.target : "en";
  const rawSource =
    typeof body.source === "string" && isSupportedLanguageCode(body.source) ? body.source : "es";
  // Never a call of one repeated language: that asks the model to interpret a
  // language into itself (the doubled-side rule, lib/translate/pair.ts). The
  // client skips the session entirely in that case; this is the backstop.
  const source = rawSource === target ? (target === "en" ? "es" : "en") : rawSource;
  const direction: CallDirection = { source, target };

  // "clone" — the model writes TEXT and /api/tts speaks it in the app's own
  // voices (Liz's clone reading her own words in English, per the
  // voice-follows-speaker rule in lib/tts/voice.ts). Cheaper AND the better
  // voice; it costs about a second of extra latency because the sentence has
  // to finish before it can be synthesised.
  // "instant" — the model speaks directly. Lower latency, a stock voice, and
  // the most expensive line item on the call. Kept because latency on a real
  // two-phone call is the one thing that cannot be measured from here.
  const mode: "clone" | "instant" = body.mode === "instant" ? "instant" : "clone";

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

  const session = buildCallSession({
    direction,
    model,
    voice,
    transcribeModel,
    mode
  });

  try {
    const res = await fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: CALL_SECRET_TTL_SECONDS },
        session
      }),
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

    // The open bracket of a session that will bill until someone hangs up.
    // Its closing line — with the dollars on it — is written by
    // /api/call/usage; both are greppable as [taos-call-...] in the Vercel
    // runtime logs. A mint with no matching cost line is a call that crashed
    // or a phone that was closed mid-call, which is worth being able to see.
    console.info(
      `[taos-call-mint] mode=${mode} pair=${source}->${target} model=${model} ` +
        `context_tokens=${CALL_CONTEXT_TOKEN_LIMIT} ttl=${CALL_SECRET_TTL_SECONDS}s`
    );

    return NextResponse.json({
      clientSecret,
      callUrl: `${CALLS_URL}?model=${encodeURIComponent(model)}`,
      model,
      voice,
      mode,
      direction
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json(
      { error: "Call interpreter session error.", details: message },
      { status: 502 }
    );
  }
}
