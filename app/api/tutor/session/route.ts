// The other half of the metering seam: a session ENDED, and it lasted this
// long.
//
// POST { sessionId, seconds, reason, phase, moduleId } -> { ok: true }
//
// Phase 1 writes one structured line to the runtime log (lib/tutor/meter.ts)
// and stops there. It exists now, rather than in phase 2 with the rest of the
// metering, because the alternative is discovering at metering time that
// nothing on the server ever learns a session finished — the browser tears the
// WebRTC connection down, OpenAI bills for what it billed for, and the only
// record is a row the browser chose to write about itself.
//
// Which is exactly why this route does NOT trust `seconds`. It is a number a
// client sent about its own usage, and the client is the party with an
// interest in it being small. Phase 2 has two honest options and this route is
// shaped to take either: reserve at mint and reconcile here (the log lines
// share a sessionId for exactly that), or read duration back from OpenAI. What
// it must not do is debit this number as reported.
//
// `keepalive: true` from the browser is what makes it survive a tab close, so
// the handler is deliberately tiny — no database round trip to lose the race
// against page teardown.

import { NextRequest, NextResponse } from "next/server";
import { tutorEnabled } from "@/lib/release";
import { getUserFromRequest } from "@/lib/authServer";
import { logTutorSessionEvent, type TutorSessionEndReason } from "@/lib/tutor/meter";

export const runtime = "nodejs";
export const maxDuration = 10;

const REASONS: readonly TutorSessionEndReason[] = ["user", "cap", "idle", "error", "unknown"];

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!tutorEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Costs nothing to call, so guardSpend would be the wrong fence — but an
  // anonymous caller has no session to end, and a metering log full of
  // unattributable rows is worse than a short one.
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Please sign in to use the tutor." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    sessionId?: string;
    seconds?: number;
    reason?: string;
    phase?: string;
    moduleId?: string;
  };

  const sessionId = String(body.sessionId ?? "").slice(0, 64);
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
  }
  const raw = typeof body.seconds === "number" && Number.isFinite(body.seconds) ? body.seconds : 0;
  // Clamped to a day: a client reporting a nonsense duration should show up in
  // the log as a bounded number rather than skew every average built on it.
  const seconds = Math.min(86_400, Math.max(0, Math.round(raw)));
  const reason = (REASONS as readonly string[]).includes(String(body.reason))
    ? (body.reason as TutorSessionEndReason)
    : "unknown";

  logTutorSessionEvent({
    event: "end",
    sessionId,
    userId: user.id,
    seconds,
    reason,
    phase: typeof body.phase === "string" ? body.phase.slice(0, 32) : undefined,
    moduleId: typeof body.moduleId === "string" ? body.moduleId.slice(0, 64) : null
  });

  return NextResponse.json({ ok: true });
}
