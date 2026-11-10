import { NextRequest, NextResponse } from "next/server";
import { guardInterpreter } from "@/lib/interpreter/guard";
import { interpreterLogLine, parseInterpreterSummary } from "@/lib/interpreter/cost";
import { interpreterModel } from "@/lib/interpreter/engine";
import { parseTimelineDigest, timelineLogLine } from "@/lib/interpreter/timeline";

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
// With the founder's Diagnostics chip on, the phone also posts `diag`: one
// digest per leg of what KINDS of events the provider sent and when —
//
//   [taos-interpreter-diag] engine=grok-voice leg=0 transport=realtime-ws
//     speech_started=7 committed=6 responses=6 done_completed=1
//     done_cancelled=5 with_audio=1 … last_in=response.done reasoning=high
//
// — so a table test that "went quiet" can be read from the log. The same
// rule holds: parseTimelineDigest rebuilds each field as a number or a single
// protocol token (lib/interpreter/timeline.ts, safeToken), and a `diag` that
// is anything else is dropped whole. The session's line is written either way.
//
// Same door as every interpreter route; spends nothing.

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardInterpreter(req);
  if (!guard.ok) return guard.response;
  const raw = (await req.json().catch(() => null)) as unknown;
  const summary = parseInterpreterSummary(raw);
  if (!summary) return NextResponse.json({ error: "Bad usage." }, { status: 400 });
  console.info(interpreterLogLine(summary, interpreterModel(summary.engine)));
  const diag = parseTimelineDigest((raw as { diag?: unknown } | null)?.diag);
  for (const leg of diag ?? []) console.info(timelineLogLine(summary.engine, leg));
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
