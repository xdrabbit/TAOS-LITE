import { NextRequest, NextResponse } from "next/server";
import { parseSummary, tabletopLogLine } from "@/lib/tabletop/metrics";
import { isFounder } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";

export const runtime = "nodejs";
export const maxDuration = 10;

// The /tabletop brain A/B's one log line per session (Tom, 2026-10-21):
//
//   [taos-tabletop] brain=gemini seconds=184 segments=12 first_partial_ms_p50=…
//
// The phone measures (lib/tabletop/metrics.ts) and posts the NUMBERS here when
// a session ends; this route checks them and writes the line to the Vercel
// runtime log. parseSummary refuses anything but known numeric fields, so no
// transcript — no text of any kind — can reach the log through it. Nothing is
// stored.
//
// Founders only, like the brain switch itself; spends nothing. guardSpend is
// here for the identity it resolves, not for a budget.

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardSpend(req);
  if (!guard.ok) return guard.response;
  if (!isFounder(guard.user?.email)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const summary = parseSummary(await req.json().catch(() => null));
  if (!summary) return NextResponse.json({ error: "Bad metrics." }, { status: 400 });
  console.info(tabletopLogLine(summary));
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
