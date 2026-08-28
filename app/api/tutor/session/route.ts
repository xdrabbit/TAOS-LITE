// The other half of the metering seam: a session ENDED, and it lasted this
// long.
//
// POST { sessionId, seconds, reason, phase, moduleId } -> { ok, billedSeconds, balance }
//
// Phase 1 wrote one structured line to the runtime log and stopped there,
// under a comment explaining exactly why it would not trust the `seconds` it
// was sent: it is a number a client sent about its own usage, and the client
// is the party with an interest in it being small. That still holds, and it is
// now enforced rather than promised — `settleTutorSession` reconciles against
// the `started_at` the SERVER stamped at mint, caps the result at the grant,
// and records the client's figure in `tutor_sessions.client_seconds` beside
// the billed one so drift between them is visible instead of silent.
//
// What this route DOES take from the body is the reason (for the log) and the
// fact that the session is over at all. Everything that touches the balance is
// read from the row the mint wrote.
//
// `keepalive: true` from the browser is what makes it survive a tab close, so
// the handler stays small — but it does now do a database round trip, because
// the alternative is a hold that sits until the reaper collects it. If the
// beacon loses the race with page teardown, `tutor_reap_open_sessions` settles
// the session at its full grant on the learner's next check: the pessimistic
// answer, and the only one that cannot be gamed by closing a tab.

import { NextRequest, NextResponse } from "next/server";
import { tutorEnabled } from "@/lib/release";
import { getUserFromRequest } from "@/lib/authServer";
import {
  readTutorBalance,
  settleTutorSession,
  TutorMeterUnavailableError,
  type TutorSessionEndReason
} from "@/lib/tutor/meter";

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
  // Clamped to a day before it is written down. It is not billed, but a
  // nonsense number in the drift column would skew every average built on it.
  const clientSeconds = Math.min(86_400, Math.max(0, Math.round(raw)));
  const reason = (REASONS as readonly string[]).includes(String(body.reason))
    ? (body.reason as TutorSessionEndReason)
    : "unknown";

  try {
    const { billedSeconds } = await settleTutorSession({
      user: { id: user.id, email: user.email },
      sessionId,
      clientSeconds,
      reason,
      phase: typeof body.phase === "string" ? body.phase.slice(0, 32) : undefined,
      moduleId: typeof body.moduleId === "string" ? body.moduleId.slice(0, 64) : null
    });

    // Read the balance back so the client's header chip is right the instant
    // the session ends, without a second round trip on a page that may be
    // seconds from unloading.
    const balance = await readTutorBalance({ id: user.id, email: user.email });

    return NextResponse.json({
      ok: true,
      billedSeconds,
      balance: {
        unlimited: balance.unlimited,
        tier: balance.tier,
        period: balance.period,
        remainingSeconds: balance.unlimited ? -1 : balance.remainingSeconds,
        packSeconds: balance.packSeconds
      }
    });
  } catch (error) {
    if (error instanceof TutorMeterUnavailableError) {
      // eslint-disable-next-line no-console
      console.error(error.message);
      return NextResponse.json({ ok: false, error: "metering_unavailable" }, { status: 503 });
    }
    // Never fail loudly at the learner: they have already hung up. The
    // reservation is not lost — the reaper settles it at the full grant.
    // eslint-disable-next-line no-console
    console.error(
      `taos.tutor.session settle_error · ${sessionId} · ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return NextResponse.json({ ok: false });
  }
}
