import { NextRequest, NextResponse } from "next/server";
import { guardWalkie } from "@/lib/walkie/guard";
import { ackWalkieMessage, WalkieStoreError } from "@/lib/walkie/store";
import { formatWalkieTiming, readStoredTimings } from "@/lib/walkie/timing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// POST /api/walkie/ack  { id, kind: "delivered" | "played", deliver_ms?, release_to_play_ms? }
//
// The partner's phone reports the two halves of the turn only it can see:
// "delivered" when it has the message, "played" when the audio finished.
// On "played" this route logs the COMPLETE [taos-walkie-timing] line — the
// server phases come back off the row, the two delivery numbers come from
// the partner. release_to_play_ms spans two phones' clocks and is reported
// as such (the PR body says so); deliver_ms is one clock and exact.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function num(v: unknown): number | "?" {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : "?";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardWalkie(req);
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as {
    id?: unknown;
    kind?: unknown;
    deliver_ms?: unknown;
    release_to_play_ms?: unknown;
  };
  const id = typeof body.id === "string" && UUID.test(body.id) ? body.id : null;
  const kind = body.kind === "delivered" || body.kind === "played" ? body.kind : null;
  if (!id || !kind) return NextResponse.json({ error: "Bad receipt." }, { status: 400 });

  try {
    const row = await ackWalkieMessage(id, kind);
    // A second ack of the same kind (two tabs, a retry) changes nothing and
    // logs nothing: the line is written once per turn.
    if (row && kind === "played") {
      const s = readStoredTimings(row.timings);
      console.log(
        formatWalkieTiming({
          status: "ok",
          http: 200,
          recMs: s.rec_ms ?? "?",
          uploadMs: s.upload_ms ?? "?",
          transcribeMs: s.transcribe_ms ?? "?",
          translateMs: s.translate_ms ?? "?",
          ttsMs: s.tts_ms ?? "?",
          deliverMs: num(body.deliver_ms),
          releaseToPlayMs: num(body.release_to_play_ms),
          busyBlocked: s.busy_blocked ?? "?",
          cancelled: s.cancelled ?? "?",
          src: row.source_lang,
          tgt: row.target_lang,
          audioBytes: "?",
          srcChars: row.original_text.length,
          outChars: row.translation_text.length,
          totalMs: s.total_ms ?? "?",
          err: "?"
        })
      );
    }
    return NextResponse.json({ ok: true, stamped: Boolean(row) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof WalkieStoreError ? error.code : "failed";
    console.error(`[taos-walkie] ack_failed code=${code}`);
    return NextResponse.json({ error: "Could not record the receipt." }, { status: 502 });
  }
}
