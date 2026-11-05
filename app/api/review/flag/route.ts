import { NextRequest, NextResponse } from "next/server";
import { guardReview } from "@/lib/review/guard";
import { cleanFlagNote, isFlagReason } from "@/lib/review/flag";
import { flagReviewTurn, ReviewStoreError } from "@/lib/review/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// POST /api/review/flag { id, reason: "words"|"meaning"|"tone"|"other"|null, note? }
//   → { turn }
//
// One flag per turn, stored on the turn's own row. `reason: null` clears it.
// The note is one line (lib/review/flag.ts FLAG_NOTE_MAX); for a `words`
// flag it is where the reviewer writes what was actually said, which the
// export then uses as the probe's reference script.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardReview(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; reason?: unknown; note?: unknown };
  if (typeof body.id !== "string" || !UUID.test(body.id)) {
    return NextResponse.json({ error: "id must be a turn id." }, { status: 400 });
  }
  if (body.reason !== null && !isFlagReason(body.reason)) {
    return NextResponse.json({ error: "reason must be words, meaning, tone, other, or null." }, { status: 400 });
  }
  const note = cleanFlagNote(body.note);
  try {
    const turn = await flagReviewTurn(body.id, body.reason, note, guard.user.id);
    if (!turn) return NextResponse.json({ error: "That turn is gone." }, { status: 404 });
    console.log(`[taos-review] flag reason=${body.reason ?? "none"} note_chars=${note.length}`);
    return NextResponse.json({ turn }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof ReviewStoreError ? error.code : "failed";
    console.error(`[taos-review] flag_failed code=${code}`);
    return NextResponse.json({ error: "Could not save the flag." }, { status: 502 });
  }
}
