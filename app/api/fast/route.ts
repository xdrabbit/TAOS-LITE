import { NextRequest, NextResponse } from "next/server";
import { fastVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { resolveTextLanguages, SAME_LANGUAGE } from "@/lib/translate/textRequest";
import { FastEngineError, fastTranslate } from "@/lib/fast/engine";
import { checkFastRate } from "@/lib/fast/rateLimit";
import { FAST_MAX_CHARS } from "@/lib/fast/settle";

export const runtime = "nodejs";
// A quickie is one short provider call. If it has not answered in fifteen
// seconds the person has already retyped the sentence.
export const maxDuration = 15;

// POST /api/fast — one literal translation, for the as-you-type quickie box.
//
// ── Who may spend ──────────────────────────────────────────────────────────
// FOUNDERS ONLY, and this is the check that matters. The grid-menu entry and
// the page gate run in the browser off a session the client already holds, so
// they hide /fast without defending it; this re-asks fastVisibleTo() against
// a server-validated access token. Same 404-not-403 rule as
// /api/call/realtime: to anyone who is not a founder, this route does not
// exist. One line in Vercel (NEXT_PUBLIC_ENABLE_FAST=1) opens all three at
// once — see lib/release.ts.
//
// ── Why this route needs a rate limit when the others do not ───────────────
// Every other translation route is called once per deliberate act: a finished
// recording, a sent message, a tapped button. This one is called while
// somebody is still typing, so "many calls a minute from one account" is the
// NORMAL shape here and there is no burst that looks wrong from the outside.
// The client debounces at 300ms, but a debounce is a courtesy the browser
// extends. lib/fast/rateLimit.ts is the ceiling that does not depend on it.
//
// ── What this route does NOT do ────────────────────────────────────────────
// It does not meter the free monthly allowance. That allowance is counted in
// rows of taos_lite_translations (lib/supabase.ts, getMonthlyUsage), and the
// row is written by the client when the input SETTLES — one finished thought,
// not one keystroke. lib/fast/settle.ts holds that rule and says why it
// cannot live here: this route sees each preview individually and has no way
// to know which one was the last.

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Identity first, because founder-ness is the gate and only a validated
  // token can answer it. guardSpend touches Supabase, never a paid provider,
  // so a stranger's request stops here having cost nothing.
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!fastVisibleTo(email)) return notFound();
  if (!guard.ok) return guard.response;
  // allowAnonymous was never passed, so ok:true means a real session and a
  // real user id — which is what the rate limit is keyed on.
  const userId = guard.user?.id ?? "unknown";

  const rate = checkFastRate(userId);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many translations in a row. Give it a moment.", window: rate.window },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "5" } }
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("Request body must be valid JSON.", 400);
  }

  const raw = typeof payload.text === "string" ? payload.text : "";
  const text = raw.trim();
  if (!text) return bad("`text` is required and cannot be empty.", 400);
  if (text.length > FAST_MAX_CHARS) {
    return bad(`\`text\` is longer than ${FAST_MAX_CHARS} characters.`, 400);
  }

  // The same body shape /api/text-translate takes, parsed by the same pure
  // function: `sourceLanguage` + `targetLanguage`, with `direction: "auto"`
  // meaning "these are the two languages, but I do not know which one was
  // typed". Sharing the parser rather than writing a second one is the point —
  // two routes with two ideas of what a pair is are two routes that will
  // disagree about Cantonese on some future Tuesday.
  const resolved = resolveTextLanguages(payload);
  if (resolved === SAME_LANGUAGE) {
    return bad("`sourceLanguage` and `targetLanguage` must be two different languages.", 400);
  }
  const { pair, source } = resolved;

  try {
    const result = await fastTranslate(text, pair, source);
    return NextResponse.json(
      {
        translation: result.translation,
        engine: result.engine,
        fallback: result.fallback,
        detectedSource: result.detectedSource,
        sourceLanguage: result.detectedSource,
        targetLanguage: result.targetLanguage,
        direction: `${result.detectedSource}-${result.targetLanguage}`
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof FastEngineError) {
      return NextResponse.json(
        { error: "Fast translation failed.", details: error.message },
        { status: error.status, headers: { "Cache-Control": "no-store" } }
      );
    }
    const details = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json(
      { error: "Fast translation failed.", details },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
