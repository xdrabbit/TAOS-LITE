import { NextRequest, NextResponse } from "next/server";
import { type TabletopDirection } from "@/lib/tabletop/instructions";
import {
  buildTabletopSession,
  TABLETOP_CONTEXT_TOKEN_LIMIT,
  TABLETOP_SECRET_TTL_SECONDS
} from "@/lib/tabletop/session";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";
import { guardSpend } from "@/lib/spendGuard";

export const runtime = "nodejs";
export const maxDuration = 30;

// Mints an ephemeral client secret for /tabletop "live" mode: a GA Realtime
// session that translates one push-to-talk turn AS THE PERSON SPEAKS. Output
// is TEXT ONLY (streams onto the listener's pane; much cheaper than audio
// output) — the spoken readout happens at turn end via /api/tts with the
// cloned voices. The session outlives turns: the client swaps direction
// per turn with session.update and mutes the mic track between turns so
// idle table time doesn't stream (or bill) speech.
//
// SIGNED-IN ONLY since 8/19 (ship report cdf9f02a): a minted client secret is
// a live, billing Realtime session, and every cap on it is client-side.
//
// ── Where the money goes ───────────────────────────────────────────────────
// Text output already removes the largest line item a realtime surface can
// have (the model's own speech, $64/Mtok), which is why a table turn is the
// cheapest of the three. What was left uncapped until 2026-08-28 is the
// re-read: ONE session serves the whole party, so by the tenth turn "the
// conversation so far" is nine other people's turns, re-read as audio at
// $32/Mtok on every phrase. lib/tabletop/session.ts carries the cap and
// docs/realtime-cost-model.md carries the measurements.

const CLIENT_SECRETS_URL =
  process.env.OPENAI_REALTIME_CLIENT_SECRETS_URL ??
  "https://api.openai.com/v1/realtime/client_secrets";
const CALLS_URL =
  process.env.OPENAI_REALTIME_CALLS_URL ?? "https://api.openai.com/v1/realtime/calls";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardSpend(req);
  if (!guard.ok) return guard.response;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  // The two ends of the table, as catalog codes. Unknown or missing values
  // fall back to the pair the table shipped with rather than reaching the
  // prompt raw — an interpreter told to output "xx" writes whatever it likes.
  const body = (await req.json().catch(() => ({}))) as {
    source?: string;
    target?: string;
  };
  const source =
    typeof body.source === "string" && isSupportedLanguageCode(body.source) ? body.source : "en";
  const rawTarget =
    typeof body.target === "string" && isSupportedLanguageCode(body.target) ? body.target : "es";
  // Never a table of one repeated language: that asks the model to interpret
  // a language into itself (the doubled-side rule, lib/translate/pair.ts).
  const target = rawTarget === source ? (source === "en" ? "es" : "en") : rawTarget;
  const direction: TabletopDirection = { source, target };

  // Same model policy as /live and /call: full gpt-realtime (mini drifted at
  // the 7/8 field test). Reuses the /live override env, plus its own.
  const model =
    process.env.OPENAI_TABLETOP_REALTIME_MODEL?.trim() ||
    process.env.OPENAI_LIVE_REALTIME_MODEL?.trim() ||
    "gpt-realtime";
  const transcribeModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";

  const session = buildTabletopSession({ direction, model, transcribeModel });

  try {
    const res = await fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // Same reasoning as /call and /live: a minted secret is spendable, and
        // the client spends it immediately.
        expires_after: { anchor: "created_at", seconds: TABLETOP_SECRET_TTL_SECONDS },
        session
      }),
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

    // Greppable as [taos-tabletop-mint] in the Vercel runtime logs. One line
    // per table, not per turn — the session outlives every turn it serves.
    console.info(
      `[taos-tabletop-mint] pair=${source}->${target} model=${model} ` +
        `context_tokens=${TABLETOP_CONTEXT_TOKEN_LIMIT ?? "off"} ttl=${TABLETOP_SECRET_TTL_SECONDS}s`
    );

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
