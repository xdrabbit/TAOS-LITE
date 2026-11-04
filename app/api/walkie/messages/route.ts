import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { guardWalkie } from "@/lib/walkie/guard";
import { isWalkieRoom, normalizeWalkieRoom } from "@/lib/walkie/room";
import {
  getWalkieMessage,
  getWalkieReceipts,
  listWalkieMessages,
  WALKIE_RECEIPTS_LIMIT,
  signWalkieAudio,
  sweepWalkieMessages,
  WalkieStoreError,
  type WalkieMessageRow
} from "@/lib/walkie/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/walkie/messages?room=XYZ        the room's unexpired log, oldest first
// GET /api/walkie/messages?room=XYZ&after=<iso>   only rows created after that
//                                          instant (the on-air catch-up poll:
//                                          a "ready" broadcast that found no
//                                          subscriber is otherwise lost)
// GET /api/walkie/messages?id=<uuid>       one message (the partner, on "ready")
// GET /api/walkie/messages?ids=<uuid,…>    receipts only — { receipts: [{ id,
//                                          delivered_at, played_at }] }: the
//                                          SENDER re-reads what the partner
//                                          stamped when the "got" / "played"
//                                          broadcast may have been lost
//                                          (2026-11-02). At most 10 ids.
//
// Each message comes back with a signed link to its spoken translation. Text
// is returned in BOTH languages; the screen shows the reader's — the sender
// reads what they said, the partner reads the translation — and the row
// never says who the reader is. Access is the room code plus the founders
// gate, the same trust /call puts in its room code: a five-character secret
// shared by a link between two founders. Flagged in the PR as a decision.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WalkieMessageOut extends WalkieMessageRow {
  speech_url: string | null;
}

async function withUrl(row: WalkieMessageRow): Promise<WalkieMessageOut> {
  return { ...row, speech_url: await signWalkieAudio(row.speech_path) };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await guardWalkie(req);
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const idsRaw = url.searchParams.get("ids");
  const room = normalizeWalkieRoom(url.searchParams.get("room"));
  try {
    if (idsRaw !== null) {
      const ids = idsRaw.split(",").map((v) => v.trim()).filter(Boolean);
      if (ids.length === 0 || ids.length > WALKIE_RECEIPTS_LIMIT || ids.some((v) => !UUID.test(v))) {
        return NextResponse.json({ error: "Bad ids." }, { status: 400 });
      }
      const receipts = await getWalkieReceipts(ids);
      return NextResponse.json({ receipts }, { headers: { "Cache-Control": "no-store" } });
    }
    if (id) {
      if (!UUID.test(id)) return NextResponse.json({ error: "Bad id." }, { status: 400 });
      const row = await getWalkieMessage(id);
      if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });
      return NextResponse.json({ message: await withUrl(row) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!isWalkieRoom(room)) return NextResponse.json({ error: "Channel code is not valid." }, { status: 400 });
    const afterRaw = url.searchParams.get("after");
    const after = afterRaw && Number.isFinite(Date.parse(afterRaw)) ? new Date(Date.parse(afterRaw)).toISOString() : null;
    const rows = await listWalkieMessages(room, Date.now(), undefined, after);
    // Belt and braces on top of the daily cron: opening a log kicks a sweep.
    // The catch-up poll (`after`) does not — every five seconds is no time
    // to be deleting things.
    if (!after) {
      try {
        waitUntil(sweepWalkieMessages().catch(() => undefined));
      } catch {
        /* outside a Vercel request context the promise still runs */
      }
    }
    const messages = await Promise.all(rows.map(withUrl));
    return NextResponse.json({ messages }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof WalkieStoreError ? error.code : "failed";
    console.error(`[taos-walkie] messages_failed code=${code}`);
    return NextResponse.json({ error: "Could not load the channel." }, { status: 502 });
  }
}
