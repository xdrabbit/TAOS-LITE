import { NextRequest, NextResponse } from "next/server";
import { guardReview } from "@/lib/review/guard";
import { explainLanguage, reviewBatchMax, REVIEW_BATCH_WINDOW_MAX_MS } from "@/lib/review/opinion";
import { runOpinionBatch } from "@/lib/review/secondOpinion";
import { ReviewStoreError } from "@/lib/review/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/review/opinion/batch { from, to, speaker?, explain? }
//   → { checked, failed, more, max }
//
// "Check all unreviewed on this day." Capped twice: the window must be one
// day (from/to at most 36 h apart, 400 otherwise), and one click sends at
// most TAOS_REVIEW_BATCH_MAX turns (50). `more` says a second click is
// needed. Only turns with no opinion yet — a re-check is the per-row button.
//
// guardReview first, like every /api/review route: guardSpend, then founders.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function instant(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardReview(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => ({}))) as { from?: unknown; to?: unknown; speaker?: unknown; explain?: unknown };
  const from = instant(body.from);
  const to = instant(body.to);
  if (from === null || to === null || to <= from || to - from > REVIEW_BATCH_WINDOW_MAX_MS) {
    return NextResponse.json({ error: "from and to must span one day." }, { status: 400 });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server misconfiguration: missing OPENAI_API_KEY." }, { status: 500 });
  }
  const max = reviewBatchMax();
  const speaker = typeof body.speaker === "string" && UUID.test(body.speaker) ? body.speaker : null;
  try {
    const result = await runOpinionBatch(
      { fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString(), speakerId: speaker },
      { apiKey },
      max,
      explainLanguage(body.explain)
    );
    console.log(`[taos-review] opinion_batch checked=${result.checked} failed=${result.failed} more=${result.more ? 1 : 0} max=${max}`);
    return NextResponse.json({ ...result, max }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof ReviewStoreError ? error.code : "failed";
    console.error(`[taos-review] opinion_batch_failed code=${code}`);
    return NextResponse.json({ error: "Could not check the day." }, { status: 502 });
  }
}
