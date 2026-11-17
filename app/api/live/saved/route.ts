import { NextRequest, NextResponse } from "next/server";
import { guardLiveSaved, liveSaveAllowed } from "@/lib/live/saveAccess";
import { LiveSavedError, listSavedLive, liveSaveTablesReady } from "@/lib/live/savedStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET /api/live/saved → { ready, canSave, sessions: [...] }
//
// The signed-in user's own saved /live conversations, newest first, each with
// its line count. Sign-in is the only gate: what somebody saved stays theirs
// to read and delete even if TAOS_LIVE_SAVE is later narrowed (`canSave` tells
// the page whether they can still add to it). Tables missing → ready:false and
// an empty list, not an error.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await guardLiveSaved(req);
  if (!guard.ok) return guard.response;
  const headers = { "Cache-Control": "no-store" };
  const canSave = await liveSaveAllowed(guard.user);
  if (!(await liveSaveTablesReady())) {
    return NextResponse.json({ ready: false, canSave, sessions: [] }, { headers });
  }
  try {
    const sessions = await listSavedLive(guard.user.id);
    console.info(`[taos-live-save] list sessions=${sessions.length}`);
    return NextResponse.json({ ready: true, canSave, sessions }, { headers });
  } catch (error) {
    const code = error instanceof LiveSavedError ? error.code : "failed";
    console.error(`[taos-live-save] list_failed code=${code}`);
    return NextResponse.json({ error: "Could not load." }, { status: 502, headers });
  }
}
