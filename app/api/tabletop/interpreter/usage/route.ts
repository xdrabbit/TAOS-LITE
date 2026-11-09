import { NextRequest, NextResponse } from "next/server";
import { guardInterpreter } from "@/lib/interpreter/guard";
import { interpreterLogLine, parseInterpreterSummary } from "@/lib/interpreter/cost";
import { interpreterModel } from "@/lib/interpreter/engine";

export const runtime = "nodejs";
export const maxDuration = 10;

// Interpreter mode's one cost line per session:
//
//   [taos-interpreter] engine=openai-realtime model=gpt-realtime-2.1 secs=1184
//     in_tokens=… out_tokens=… cached_tokens=… est_usd=1.9321 barge_ins=4 …
//
// The phone tallies what the providers report (lib/interpreter/cost.ts) and
// posts the NUMBERS here when the session ends; this route checks them and
// writes the line to the Vercel runtime log. Nothing is stored.
//
// NO TEXT. parseInterpreterSummary rebuilds every field as a number or
// matches it against a closed set, and `model` is resolved HERE from the
// engine — never a string the phone sent. There is no path by which a
// transcript, the briefing or the context block reaches this line.
//
// Same door as every interpreter route; spends nothing.

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardInterpreter(req);
  if (!guard.ok) return guard.response;
  const summary = parseInterpreterSummary(await req.json().catch(() => null));
  if (!summary) return NextResponse.json({ error: "Bad usage." }, { status: 400 });
  console.info(interpreterLogLine(summary, interpreterModel(summary.engine)));
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
