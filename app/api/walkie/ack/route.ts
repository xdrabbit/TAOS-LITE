import { NextRequest, NextResponse } from "next/server";
import { guardWalkie } from "@/lib/walkie/guard";
import { ackWalkieMessage, getWalkieMessage, WalkieStoreError, type WalkieMessageRow } from "@/lib/walkie/store";
import {
  formatWalkieTiming,
  isWalkieFailStage,
  readStoredTimings,
  WALKIE_CLIENT_FAIL_STAGES,
  type WalkieFailStage,
  type WalkieTimingFields
} from "@/lib/walkie/timing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// POST /api/walkie/ack
//   { id, kind: "delivered" }
//   { id, kind: "played", deliver_ms?, release_to_play_ms? }
//   { id, kind: "failed", stage: "deliver" | "playback" }
//
// The phones report the halves of a turn only they can see. "delivered"
// when the partner has the message, "played" when its audio finished — on
// "played" this route logs the COMPLETE [taos-walkie-timing] line (server
// phases off the row, the two delivery numbers from the partner).
//
// "failed" is the half the server never sees: the SENDER reports `deliver`
// when no "got" came back inside lib/walkie/state.ts DELIVERY_WAIT_MS; the
// RECEIVER reports `playback` when play() was refused (iOS audio not
// unlocked, an interrupted session). Either logs a status=error line with
// fail_stage set, from the row's numbers — never the text — and stamps
// nothing: a late delivery after a "deliver" report still counts, and the
// row's receipts stay what the phones actually did.
//
// release_to_play_ms spans two phones' clocks and is reported as such (the
// PR body says so); deliver_ms is one clock and exact.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function num(v: unknown): number | "?" {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : "?";
}

function lineFromRow(
  row: WalkieMessageRow,
  extra: Partial<Pick<WalkieTimingFields, "status" | "deliverMs" | "releaseToPlayMs" | "failStage" | "err">>
): string {
  const s = readStoredTimings(row.timings);
  return formatWalkieTiming({
    status: "ok",
    http: 200,
    recMs: s.rec_ms ?? "?",
    uploadMs: s.upload_ms ?? "?",
    transcribeMs: s.transcribe_ms ?? "?",
    translateMs: s.translate_ms ?? "?",
    ttsMs: s.tts_ms ?? "?",
    deliverMs: "?",
    releaseToPlayMs: "?",
    busyBlocked: s.busy_blocked ?? "?",
    cancelled: s.cancelled ?? "?",
    failStage: "?",
    src: row.source_lang,
    tgt: row.target_lang,
    audioBytes: "?",
    srcChars: row.original_text.length,
    outChars: row.translation_text.length,
    totalMs: s.total_ms ?? "?",
    err: "?",
    ...extra
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardWalkie(req);
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as {
    id?: unknown;
    kind?: unknown;
    stage?: unknown;
    deliver_ms?: unknown;
    release_to_play_ms?: unknown;
  };
  const id = typeof body.id === "string" && UUID.test(body.id) ? body.id : null;
  const kind = body.kind === "delivered" || body.kind === "played" || body.kind === "failed" ? body.kind : null;
  if (!id || !kind) return NextResponse.json({ error: "Bad receipt." }, { status: 400 });

  try {
    if (kind === "failed") {
      const stage: WalkieFailStage | null =
        isWalkieFailStage(body.stage) && WALKIE_CLIENT_FAIL_STAGES.includes(body.stage) ? body.stage : null;
      if (!stage) return NextResponse.json({ error: "Bad receipt." }, { status: 400 });
      const row = await getWalkieMessage(id);
      if (row) console.log(lineFromRow(row, { status: "error", failStage: stage, err: `${stage}_failed` }));
      return NextResponse.json({ ok: true, stamped: false }, { headers: { "Cache-Control": "no-store" } });
    }

    const row = await ackWalkieMessage(id, kind);
    // A second ack of the same kind (two tabs, a retry) changes nothing and
    // logs nothing: the line is written once per turn.
    if (row && kind === "played") {
      console.log(lineFromRow(row, { deliverMs: num(body.deliver_ms), releaseToPlayMs: num(body.release_to_play_ms) }));
    }
    return NextResponse.json({ ok: true, stamped: Boolean(row) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof WalkieStoreError ? error.code : "failed";
    console.error(`[taos-walkie] ack_failed code=${code}`);
    return NextResponse.json({ error: "Could not record the receipt." }, { status: 502 });
  }
}
