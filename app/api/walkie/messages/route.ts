import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { guardWalkie } from "@/lib/walkie/guard";
import { isWalkieRoom, normalizeWalkieRoom } from "@/lib/walkie/room";
import {
  getWalkieMessage,
  listWalkieMessages,
  signWalkieAudio,
  sweepWalkieMessages,
  WalkieStoreError,
  type WalkieMessageRow
} from "@/lib/walkie/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/walkie/messages?room=XYZ        the room's unexpired log, oldest first
// GET /api/walkie/messages?id=<uuid>       one message (the partner, on "ready")
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
  const room = normalizeWalkieRoom(url.searchParams.get("room"));
  try {
    if (id) {
      if (!UUID.test(id)) return NextResponse.json({ error: "Bad id." }, { status: 400 });
      const row = await getWalkieMessage(id);
      if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });
      return NextResponse.json({ message: await withUrl(row) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!isWalkieRoom(room)) return NextResponse.json({ error: "Channel code is not valid." }, { status: 400 });
    const rows = await listWalkieMessages(room);
    // Belt and braces on top of the daily cron: opening a log kicks a sweep.
    try {
      waitUntil(sweepWalkieMessages().catch(() => undefined));
    } catch {
      /* outside a Vercel request context the promise still runs */
    }
    const messages = await Promise.all(rows.map(withUrl));
    return NextResponse.json({ messages }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof WalkieStoreError ? error.code : "failed";
    console.error(`[taos-walkie] messages_failed code=${code}`);
    return NextResponse.json({ error: "Could not load the channel." }, { status: 502 });
  }
}
