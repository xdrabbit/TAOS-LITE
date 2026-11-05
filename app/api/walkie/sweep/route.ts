import { NextRequest, NextResponse } from "next/server";
import { walkieEnabled } from "@/lib/walkie/flag";
import { guardWalkie, walkieNotFound } from "@/lib/walkie/guard";
import { sweepWalkieMessages } from "@/lib/walkie/store";
import { sweepReviewTurns } from "@/lib/review/store";
import { reviewNightlyEnabled } from "@/lib/review/opinion";
import { runNightlyOpinions } from "@/lib/review/secondOpinion";

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
//
// Since 2026-11-04 the same pass also sweeps the founder review turns
// (lib/review/store.ts, 14 days): one daily cron, one secret, two tables.
// It runs behind this route's flag like everything else here, so a
// deployment with Taokie switched off needs /api/review/sweep pointed at by
// a cron line of its own — the review page kicks the sweep too, so a
// founder who looks never sees an expired turn either way.
//
// Since 2026-11-05 the CRON path may also run the review second-opinion
// nightly pass (lib/review/secondOpinion.ts) — only when TAOS_REVIEW_NIGHTLY=1
// (off by default), only over the last day's unreviewed kept turns, and only
// one batch's worth (TAOS_REVIEW_BATCH_MAX). A founder calling this route by
// hand never triggers it: that is what the page's "check all" button is for.
// Who may reach the spend: the cron, by CRON_SECRET, or a founder session
// through guardWalkie (guardSpend first, lib/walkie/guard.ts) — and the
// founder path never runs the batch at all.

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
  const review = await sweepReviewTurns().catch(() => ({ scanned: 0, objectsRemoved: 0, rowsDeleted: 0, error: "threw" }));
  console.log(
    `[taos-review] sweep by=${isCron ? "cron" : "founder"} scanned=${review.scanned}` +
      ` objects_removed=${review.objectsRemoved} rows_deleted=${review.rowsDeleted} err=${review.error ?? "?"}`
  );
  if (isCron && reviewNightlyEnabled()) {
    const apiKey = process.env.OPENAI_API_KEY;
    const nightly = apiKey
      ? await runNightlyOpinions({ apiKey }).catch(() => ({ checked: 0, failed: 0, more: false }))
      : { checked: 0, failed: 0, more: false };
    console.log(`[taos-review] nightly checked=${nightly.checked} failed=${nightly.failed} more=${nightly.more ? 1 : 0} key=${apiKey ? 1 : 0}`);
  }
  return NextResponse.json({ ...result, review }, {
    status: result.error || review.error ? 502 : 200,
    headers: { "Cache-Control": "no-store" }
  });
}
