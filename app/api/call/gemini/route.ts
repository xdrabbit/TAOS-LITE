import { NextRequest, NextResponse } from "next/server";
import {
  buildGeminiSetup,
  GEMINI_AUTH_TOKENS_URL,
  GEMINI_CONSTRAINED_WS_URL,
  GEMINI_LIVE_TRANSLATE_MODEL,
  GEMINI_NEW_SESSION_WINDOW_MS,
  GEMINI_TOKEN_TTL_MS,
  geminiLanguageCode
} from "@/lib/call/geminiSession";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";
import { callVisibleTo, isFounder } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";

export const runtime = "nodejs";
export const maxDuration = 30;

// Mints a ONE-USE ephemeral token for the Gemini arm of the /call bake-off
// (Tom, 2026-09-28): gemini-3.5-live-translate-preview does the translation
// AND the speech, in Google's voices, on a WebSocket the browser opens itself.
//
// ── Who may spend ──────────────────────────────────────────────────────────
// Founders, and only founders — narrower than /api/call/realtime, which also
// opens if NEXT_PUBLIC_ENABLE_CALL ever ships /call to customers. The engine
// choice is an evaluation, not a product: even a public /call would not let a
// customer reach this. Everyone else gets the same 404 the realtime route
// gives, before Google is called at all.
//
// ── Why a token, and what is in it ─────────────────────────────────────────
// GEMINI_API_KEY stays on the server. The token carries the whole session
// setup — model, target language, the meaning-first instruction — and the
// browser connects to the Constrained endpoint, which takes its setup from
// the token and nothing else. A founder's phone cannot turn it into a
// general-purpose Gemini session, or point it at a pricier model.
//
// ── Where the money goes ───────────────────────────────────────────────────
// 25 tokens per second of audio each way, $3.50/M in and $21/M out, and the
// output streams continuously — silence is billed. lib/call/cost.ts has the
// measurement. The closing line with the dollars on it is posted by the
// phone for EVERY session that connected (lib/call/interpreterGemini.ts).

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!callVisibleTo(email) || !isFounder(email)) return notFound();
  if (!guard.ok) return guard.response;

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing GEMINI_API_KEY." },
      { status: 500 }
    );
  }

  // Only the TARGET reaches Gemini: Live Translate auto-detects the source
  // and has no setting for it. The source is still read, for the log line —
  // a detected language the pair did not expect is worth being able to see.
  const body = (await req.json().catch(() => ({}))) as { source?: string; target?: string };
  const target =
    typeof body.target === "string" && isSupportedLanguageCode(body.target) ? body.target : "en";
  const source =
    typeof body.source === "string" && isSupportedLanguageCode(body.source) ? body.source : "?";

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
      // The payload is Google's error body. It never contains the key (the
      // key went in the URL of a request this route made), so it is safe to
      // hand back — and a founder debugging a failed call needs it.
      return NextResponse.json(
        {
          error: "Failed to mint Gemini interpreter session.",
          details: payload ? JSON.stringify(payload).slice(0, 500) : `HTTP ${res.status}`
        },
        { status: 502 }
      );
    }

    console.info(
      `[taos-call-mint] engine=gemini pair=${source}->${target} ` +
        `target_code=${geminiLanguageCode(target)} model=${GEMINI_LIVE_TRANSLATE_MODEL}`
    );

    return NextResponse.json(
      {
        token,
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
      { error: "Gemini interpreter session error.", details: message },
      { status: 502 }
    );
  }
}
