import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { guardReview } from "@/lib/review/guard";
import { reviewRetentionDays } from "@/lib/review/flag";
import {
  listReviewSpeakers,
  listReviewTurns,
  signReviewAudio,
  sweepReviewTurns,
  ReviewStoreError,
  REVIEW_LIST_LIMIT
} from "@/lib/review/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/review/turns?from=<iso>&to=<iso>&speaker=<user_id>&flagged=1&sort=suspects
//   → { turns: [...row, audio_url], speakers: [{ id, email }], retentionDays }
//
// Newest first, unexpired only, each with a one-hour signed link to its
// clip. `from`/`to` are instants the page computes from the chosen day in
// the phone's own timezone, so "today" means the reviewer's today.
//
// Opening the page also kicks the sweep, best-effort and off the response:
// the daily cron is the real clock, but a founder looking at the list should
// never see a turn the retention promise says is gone.

function isoOrNull(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await guardReview(req);
  if (!guard.ok) return guard.response;
  const url = new URL(req.url);
  const speaker = url.searchParams.get("speaker");
  const filter = {
    fromIso: isoOrNull(url.searchParams.get("from")),
    toIso: isoOrNull(url.searchParams.get("to")),
    speakerId: speaker && UUID.test(speaker) ? speaker : null,
    flaggedOnly: url.searchParams.get("flagged") === "1",
    // Second opinion: ?sort=suspects puts the lowest grade / lowest word
    // agreement first and the unreviewed last (lib/review/opinion.ts).
    sort: url.searchParams.get("sort") === "suspects" ? ("suspects" as const) : ("newest" as const)
  };
  try {
    const [rows, speakers] = await Promise.all([listReviewTurns(filter, Date.now(), REVIEW_LIST_LIMIT), listReviewSpeakers()]);
    const turns = await Promise.all(
      rows.map(async (row) => ({ ...row, audio_url: await signReviewAudio(row.audio_path) }))
    );
    waitUntil(sweepReviewTurns(Date.now(), 100).catch(() => undefined));
    console.log(`[taos-review] list rows=${turns.length} flagged_only=${filter.flaggedOnly ? 1 : 0}`);
    return NextResponse.json(
      { turns, speakers, retentionDays: reviewRetentionDays() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const code = error instanceof ReviewStoreError ? error.code : "failed";
    console.error(`[taos-review] list_failed code=${code}`);
    return NextResponse.json({ error: "Could not load the turns." }, { status: 502 });
  }
}
