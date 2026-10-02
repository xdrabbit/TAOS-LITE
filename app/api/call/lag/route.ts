import { NextRequest, NextResponse } from "next/server";
import { LAG_TAG, lagLabel, lagLogLine, sanitizeLagRecord } from "@/lib/call/lag";
import { callVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";

export const runtime = "nodejs";
export const maxDuration = 10;

// Where a call's lag telemetry reaches the Vercel log. The measuring and the
// reading guide live in lib/call/lag.ts; this route only writes lines:
//
//     vercel logs taos-lite | grep taos-call-lag
//
// Same shape and same fence as /api/call/usage: it spends nothing, and it
// still takes a founder's token, because a stranger who could post here could
// bury the one honest measurement under invented ones. Each phone posts its
// own interpreter's lines, so both sides of a call land here, told apart by
// `pair`.

/** A batch is ~10 records; this is the ceiling, not the expectation. */
const MAX_RECORDS = 60;

interface LagBody {
  room?: string;
  records?: unknown;
  /** Records the phone had to throw away (buffer full, or a failed post). */
  dropped?: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!callVisibleTo(email)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as LagBody;
  const room = lagLabel(body.room);
  const raw = Array.isArray(body.records) ? body.records : [];

  for (const entry of raw.slice(0, MAX_RECORDS)) {
    const record = sanitizeLagRecord(entry);
    if (record) console.info(lagLogLine(record, room));
  }

  // A gap in the turn numbers should never be a mystery: say how many lines
  // did not make it, and why that is not the same as a quiet stretch.
  const reportedDrop =
    typeof body.dropped === "number" && Number.isFinite(body.dropped)
      ? Math.min(Math.max(0, Math.round(body.dropped)), 100_000)
      : 0;
  const dropped = reportedDrop + Math.max(0, raw.length - MAX_RECORDS);
  if (dropped > 0) console.info(`${LAG_TAG} dropped room=${room} n=${dropped}`);

  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
