import { NextRequest, NextResponse } from "next/server";
import { walkieEnabled } from "@/lib/walkie/flag";
import { guardWalkie, walkieNotFound } from "@/lib/walkie/guard";
import { sweepWalkieMessages } from "@/lib/walkie/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/walkie/sweep — delete every message past its 30 days: the audio
// objects first, then the rows (lib/walkie/store.ts says why in that order).
//
// Two callers. Vercel Cron, daily (vercel.json), which sends CRON_SECRET as
// a Bearer token exactly as /api/predict/rebuild expects it; and a founder
// by hand, with a session, to ask "is anything left that should not be?".
// The cron path is still behind the flag: a deployment without Taokie has
// nothing to sweep and must not reach the table.
//
// Unlike the rebuild cron this does NOT run open when CRON_SECRET is unset —
// a delete endpoint with no credential is not something a preview should
// carry. No secret, no cron path; the founder path still works.

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!walkieEnabled()) return walkieNotFound();

  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization") ?? "";
  const isCron = Boolean(secret) && header === `Bearer ${secret}`;
  if (!isCron) {
    const guard = await guardWalkie(req);
    if (!guard.ok) return guard.response;
  }

  const result = await sweepWalkieMessages();
  console.log(
    `[taos-walkie] sweep by=${isCron ? "cron" : "founder"} scanned=${result.scanned}` +
      ` objects_removed=${result.objectsRemoved} rows_deleted=${result.rowsDeleted} err=${result.error ?? "?"}`
  );
  return NextResponse.json(result, {
    status: result.error ? 502 : 200,
    headers: { "Cache-Control": "no-store" }
  });
}
