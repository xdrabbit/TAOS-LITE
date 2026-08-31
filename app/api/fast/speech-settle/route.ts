import { NextRequest, NextResponse } from "next/server";
import { fastVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { settleFastSpeechSession, type SpeechEndReason } from "@/lib/fast/speechMeter";

export const runtime = "nodejs";
// One small write. If this has not answered in five seconds the phone has
// already put its beacon down and walked off, which the reaper covers.
export const maxDuration = 5;

// POST /api/fast/speech-settle — the streaming mic stopped; bill what it used.
//
// ── Why there is a route here at all ───────────────────────────────────────
// /fast's live mic streams audio from the PHONE to Azure over a websocket, so
// no server ever sees it (lib/fast/speechMeter.ts says why that is the deal
// and not an oversight). POST /api/fast/speech-token therefore RESERVES one
// utterance's worth of audio seconds when it mints the credential, and this is
// the other end of that reservation: the browser says how long it actually
// streamed, and the ledger row closes for that instead of for the full grant.
//
// ── The number here is reported, not measured ──────────────────────────────
// And it is treated that way. `fast_speech_settle` caps it at the reservation,
// so the worst a client can do by lying UP is pay its own grant; lying DOWN is
// the interesting direction and the fence for it is not here — it is that the
// grant was taken at mint, and that the next mint is refused when the hour's
// budget is spent. A client that reports zero forever still runs out of
// tokens; a client that reports nothing at all leaves an open session that is
// reaped at its FULL grant on its owner's next press.
//
// So this route can be honest about being the cheap, cooperative path: it
// makes an accurate bill cheaper than an inaccurate one, and the bound does
// not depend on it.
//
// ── The gate is /api/fast's ────────────────────────────────────────────────
// Same fastVisibleTo() 404, same guardSpend 401. Settling somebody else's
// session is impossible for a different reason: the SQL matches on the session
// id AND the caller's user id, so a stolen id closes nothing.

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

const REASONS: readonly SpeechEndReason[] = ["user", "cap", "error", "lost", "unknown"];

function asReason(value: unknown): SpeechEndReason {
  return typeof value === "string" && (REASONS as readonly string[]).includes(value)
    ? (value as SpeechEndReason)
    : "unknown";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!fastVisibleTo(email)) return notFound();
  if (!guard.ok) return guard.response;

  // Deliberately NOT rate limited on checkFastRate. This route only ever
  // REDUCES a bill, and refusing it would mean the reservation stays open and
  // is reaped at its full length — a rate limit here would cost the person
  // money for pressing the mic quickly, which is the opposite of the job.
  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  if (!sessionId) {
    return NextResponse.json(
      { error: "`sessionId` is required." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const raw = Number(payload.seconds);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : 0;

  const billed = await settleFastSpeechSession(
    { id: guard.user?.id ?? "unknown", email },
    sessionId,
    seconds,
    asReason(payload.reason)
  );

  // null means there was nothing to settle: already closed, already reaped, or
  // not this caller's session. All three are normal on a beacon that retries,
  // and none of them is the client's problem — so this answers 200 either way
  // and says what happened rather than turning a duplicate into an error.
  return NextResponse.json(
    { billedSeconds: billed, settled: billed !== null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
