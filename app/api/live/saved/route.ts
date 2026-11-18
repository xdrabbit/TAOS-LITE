import { NextRequest, NextResponse } from "next/server";
import { guardLiveSaved, liveSaveAllowed } from "@/lib/live/saveAccess";
import { LiveSavedError, listSavedLive, liveSaveTablesReady, parseSavedOffset } from "@/lib/live/savedStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET /api/live/saved[?offset=N] → { ready, canSave, sessions: [...], more }
//
// The signed-in user's own saved /live conversations, newest first, each with
// its line count — one page from `offset`. `more: true` means there are older
// ones: ask again with offset + the number just received. Nothing saved is
// ever out of reach of this list. Sign-in is the only gate: what somebody saved stays theirs
// to read and delete even if TAOS_LIVE_SAVE is later narrowed (`canSave` tells
// the page whether they can still add to it). Tables missing → ready:false and
// an empty list, not an error.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await guardLiveSaved(req);
  if (!guard.ok) return guard.response;
  const headers = { "Cache-Control": "no-store" };
  const canSave = await liveSaveAllowed(guard.user);
  if (!(await liveSaveTablesReady())) {
    return NextResponse.json({ ready: false, canSave, sessions: [], more: false }, { headers });
  }
  try {
    const offset = parseSavedOffset(new URL(req.url).searchParams.get("offset"));
    const { sessions, more } = await listSavedLive(guard.user.id, offset);
    console.info(`[taos-live-save] list offset=${offset} sessions=${sessions.length} more=${more ? 1 : 0}`);
    return NextResponse.json({ ready: true, canSave, sessions, more }, { headers });
  } catch (error) {
    const code = error instanceof LiveSavedError ? error.code : "failed";
    console.error(`[taos-live-save] list_failed code=${code}`);
    return NextResponse.json({ error: "Could not load." }, { status: 502, headers });
  }
}
