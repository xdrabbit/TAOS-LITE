// How many tutor minutes are left.
//
// GET -> { unlimited, tier, period, remainingSeconds, planSeconds, planLeft, packSeconds }
//
// Read from the SERVER rather than summed in the browser, even though RLS
// would happily let the client add up its own `tutor_usage` row. Three reasons,
// and the third is the one that decided it:
//
//   1. The browser cannot see open reservations the way the meter does — it
//      would show minutes that another tab has already spoken for.
//   2. It cannot see the founder bypass, which is an email check in
//      lib/release.ts, not a column.
//   3. The number on the chip has to be the same number the mint enforces. Two
//      implementations of one balance is how a UI ends up cheerfully offering
//      a session the server then refuses.
//
// Costs nothing, so it is behind auth rather than guardSpend — but it does hit
// the database, so it is not a route to poll. The client reads it on mount, on
// return from a pack purchase, and after a session settles.

import { NextRequest, NextResponse } from "next/server";
import { tutorEnabled } from "@/lib/release";
import { getUserFromRequest } from "@/lib/authServer";
import {
  readTutorBalance,
  TutorMeterUnavailableError,
  TUTOR_MIN_GRANT_SECONDS
} from "@/lib/tutor/meter";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!tutorEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Please sign in to use the tutor." }, { status: 401 });
  }

  try {
    const balance = await readTutorBalance({ id: user.id, email: user.email });
    return NextResponse.json(
      {
        unlimited: balance.unlimited,
        tier: balance.tier,
        period: balance.period,
        // -1 is "unlimited". JSON has no Infinity, and null would be
        // indistinguishable from "could not work it out".
        remainingSeconds: balance.unlimited ? -1 : balance.remainingSeconds,
        planSeconds: Number.isFinite(balance.planSeconds) ? balance.planSeconds : -1,
        planLeft: Number.isFinite(balance.planLeft) ? balance.planLeft : -1,
        packSeconds: balance.packSeconds,
        heldSeconds: balance.heldSeconds,
        canStart: balance.canStart,
        minGrantSeconds: TUTOR_MIN_GRANT_SECONDS
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof TutorMeterUnavailableError) {
      // eslint-disable-next-line no-console
      console.error(error.message);
      return NextResponse.json({ error: "metering_unavailable" }, { status: 503 });
    }
    throw error;
  }
}
