import { NextRequest, NextResponse } from "next/server";
import { guardReview } from "@/lib/review/guard";
import { sweepReviewTurns } from "@/lib/review/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/review/sweep — delete every review turn past its 14 days: the
// audio objects first, then the rows (lib/review/store.ts says why in that
// order).
//
// The daily cron does NOT call this directly: the existing walkie sweep
// (vercel.json → /api/walkie/sweep, CRON_SECRET) runs sweepReviewTurns() in
// the same pass, so no new cron line and no new secret. This route is the
// by-hand door — a founder with a session, or the cron secret if a cron
// line is ever pointed here — and the same code path.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization") ?? "";
  const isCron = Boolean(secret) && header === `Bearer ${secret}`;
  if (!isCron) {
    const guard = await guardReview(req);
    if (!guard.ok) return guard.response;
  }
  const result = await sweepReviewTurns();
  console.log(
    `[taos-review] sweep by=${isCron ? "cron" : "founder"} scanned=${result.scanned}` +
      ` objects_removed=${result.objectsRemoved} rows_deleted=${result.rowsDeleted} err=${result.error ?? "?"}`
  );
  return NextResponse.json(result, {
    status: result.error ? 502 : 200,
    headers: { "Cache-Control": "no-store" }
  });
}
