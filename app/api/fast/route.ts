import { NextRequest, NextResponse } from "next/server";
import { fastVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { resolveTextLanguages, SAME_LANGUAGE } from "@/lib/translate/textRequest";
import { FastEngineError, fastTranslate } from "@/lib/fast/engine";
import { checkFastRate } from "@/lib/fast/rateLimit";
import {
  abandonFastQuickie,
  beginFastQuickie,
  fastRefusal,
  FastMeterUnavailableError,
  recordFastQuickie
} from "@/lib/fast/meter";
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
// extends. Two ceilings do not depend on it: lib/fast/rateLimit.ts, an
// in-process window that refuses a storm for free before the body is even
// read, and the DURABLE counter inside beginFastQuickie, which is shared
// across Vercel instances and survives a cold start. The first is an
// optimisation; the second is the actual bound.
//
// ── What this route DOES meter, as of 8/31 ─────────────────────────────────
// The free monthly allowance, server-side, before the engine is called.
//
// #46 shipped this route not metering it at all, and said why: it "sees each
// preview individually and has no way to know which one was the last", so the
// bill was written by the browser 1500ms after the typing stopped. That
// premise was wrong, and the hole under it was real — a curl with a valid
// session, or a tab closed a fraction early, translated for free forever.
// lib/fast/meter.ts has the whole note. In one line: the client's settle
// measures a PAUSE IN TYPING, and the gap between two requests from one
// account is that same pause on a clock nobody can edit. So a BURST of
// previews is one billable quickie, the reservation is taken here before any
// money is spent, and FastShell no longer writes a row at all.

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

  // The money moves HERE, before the engine is touched. `begun.billed` says
  // whether this preview opened a new quickie or continued the one already
  // being typed; either way nothing below can be reached without a
  // reservation. The direction passed is the one the caller ASKED for — in
  // auto mode the detected side is not known until the engine answers, and a
  // burst key that changed mid-word would bill a phrase twice.
  const caller = { id: userId, email };
  let begun;
  try {
    begun = await beginFastQuickie({
      user: caller,
      sourceLanguage: pair[0],
      targetLanguage: pair[1],
      text,
      // `source === null` is auto: the caller named both languages but not
      // which one they typed. It changes what counts as the same question
      // being asked twice — see p_auto in the migration.
      auto: source === null
    });
  } catch (error) {
    if (error instanceof FastMeterUnavailableError) {
      // A meter that cannot answer must not be read as a green light. This is
      // the one refusal on this route that is about US, so it says so.
      return bad("Translation is temporarily unavailable.", 503);
    }
    throw error;
  }

  if (!begun.ok) {
    const { status, message } = fastRefusal(begun.reason);
    return NextResponse.json(
      {
        error: message,
        reason: begun.reason,
        ...(begun.cap !== undefined ? { used: begun.used, cap: begun.cap } : {})
      },
      {
        status,
        headers: {
          "Cache-Control": "no-store",
          ...(status === 429 ? { "Retry-After": "5" } : {})
        }
      }
    );
  }

  try {
    const result = await fastTranslate(text, pair, source);
    // Fill in the row the reservation bought. Auto mode only learns which
    // side was typed from this reply, which is why the languages are written
    // now rather than at reservation time.
    await recordFastQuickie({
      user: caller,
      rowId: begun.rowId,
      repeat: begun.repeat,
      sourceLanguage: result.detectedSource,
      targetLanguage: result.targetLanguage,
      text,
      translation: result.translation,
      engine: result.engine
    });
    return NextResponse.json(
      {
        translation: result.translation,
        engine: result.engine,
        fallback: result.fallback,
        detectedSource: result.detectedSource,
        sourceLanguage: result.detectedSource,
        targetLanguage: result.targetLanguage,
        direction: `${result.detectedSource}-${result.targetLanguage}`,
        // Cosmetic. The client shows it and never decides anything with it —
        // the number that binds is the one the reservation above was taken
        // against.
        ...(begun.cap !== undefined && begun.cap >= 0
          ? { used: begun.used, cap: begun.cap }
          : {})
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    // The engine did not answer, so the reservation bought nothing. Give it
    // back — charging for a translation that never arrived would be the
    // mirror image of the bug this metering exists to fix.
    if (begun.billed) await abandonFastQuickie(caller, begun.rowId);
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
