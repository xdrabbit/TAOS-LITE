import { NextRequest, NextResponse } from "next/server";
import {
  buildGeminiSetup,
  GEMINI_AUTH_TOKENS_URL,
  GEMINI_CONSTRAINED_WS_URL,
  GEMINI_LIVE_TRANSLATE_MODEL,
  GEMINI_NEW_SESSION_WINDOW_MS,
  GEMINI_NOT_CONFIGURED,
  GEMINI_TOKEN_TTL_MS,
  geminiLanguageCode
} from "@/lib/tabletop/geminiSession";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";
import { isFounder } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";

export const runtime = "nodejs";
export const maxDuration = 30;

// Mints a ONE-USE ephemeral token for the Gemini arm of the /tabletop brain
// A/B (Tom, 2026-10-21). Same shape as the spike's /api/call/gemini
// (spike/gemini-live-translate @ a2faa41): GEMINI_API_KEY never leaves the
// server, and the token carries the whole session setup — model, target
// language, the meaning-first instruction — so the browser, on the
// Constrained endpoint, can change none of it.
//
// One per TURN: the target is locked inside, and the target flips every time
// the phone changes hands (lib/tabletop/geminiBrain.ts).
//
// ── Who may spend ──────────────────────────────────────────────────────────
// Founders only. Everyone else gets a 404 before Google is called — the brain
// choice is an evaluation, not a product, and a non-founder's Tabletop never
// asks for it (lib/tabletop/brain.ts locks them to openai).
//
// ── Fail closed ────────────────────────────────────────────────────────────
// No key → 503 "Gemini brain not configured". The client shows it and does
// NOT fall back to OpenAI: a "Gemini" session that ran on gpt-realtime would
// put an OpenAI number in the Gemini column.

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardSpend(req);
  if (!guard.ok) return guard.response;
  if (!isFounder(guard.user?.email)) return notFound();

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: GEMINI_NOT_CONFIGURED, code: "gemini_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Only the TARGET reaches Gemini — Live Translate auto-detects the source.
  // The source is read for the log line only.
  const body = (await req.json().catch(() => ({}))) as { source?: string; target?: string };
  const source =
    typeof body.source === "string" && isSupportedLanguageCode(body.source) ? body.source : "?";
  const target =
    typeof body.target === "string" && isSupportedLanguageCode(body.target) ? body.target : null;
  if (!target) {
    return NextResponse.json({ error: "Unsupported target language." }, { status: 400 });
  }

  const now = Date.now();
  try {
    const res = await fetch(`${GEMINI_AUTH_TOKENS_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + GEMINI_TOKEN_TTL_MS).toISOString(),
        newSessionExpireTime: new Date(now + GEMINI_NEW_SESSION_WINDOW_MS).toISOString(),
        bidiGenerateContentSetup: buildGeminiSetup(target)
      }),
      cache: "no-store"
    });
    const payload = (await res.json().catch(() => null)) as { name?: unknown } | null;
    const token = typeof payload?.name === "string" ? payload.name : "";
    if (!res.ok || !token) {
      // Google's error body; it never contains the key (that went in the URL
      // of the request this route made).
      return NextResponse.json(
        {
          error: "Failed to mint Gemini tabletop session.",
          details: payload ? JSON.stringify(payload).slice(0, 500) : `HTTP ${res.status}`
        },
        { status: 502 }
      );
    }

    console.info(
      `[taos-tabletop-mint] brain=gemini pair=${source}->${target} ` +
        `target_code=${geminiLanguageCode(target)} model=${GEMINI_LIVE_TRANSLATE_MODEL}`
    );

    return NextResponse.json(
      {
        wsUrl: `${GEMINI_CONSTRAINED_WS_URL}?access_token=${encodeURIComponent(token)}`,
        model: GEMINI_LIVE_TRANSLATE_MODEL
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    // Scrubbed anyway: a fetch error that ever echoes its URL would echo the key.
    const message = (error instanceof Error ? error.message : "Unexpected error.")
      .split(apiKey)
      .join("<key>");
    return NextResponse.json(
      { error: "Gemini tabletop session error.", details: message },
      { status: 502 }
    );
  }
}
