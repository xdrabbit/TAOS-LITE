import { NextRequest, NextResponse } from "next/server";
import { guardLiveSaved, liveSaveAllowed } from "@/lib/live/saveAccess";
import { hasSavedLive, liveSaveTablesReady } from "@/lib/live/savedStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET /api/live/saved/status → { allowed, ready, hasSaved }
//
// What /live asks once, at mount, to decide what to do with the "Save this
// conversation" toggle:
//   allowed:false            → no toggle at all (not in TAOS_LIVE_SAVE's audience)
//   allowed:true,ready:false → toggle shown disabled, with a hint (the
//                              migration has not been applied yet)
//   allowed:true,ready:true  → the toggle works
// And apart from the toggle: `hasSaved` — does this user already have a
// saved conversation? That draws the link to /live/saved for someone who may
// no longer save (TAOS_LIVE_SAVE narrowed) but still has text there to read,
// export or delete. Someone who never saved and may not save sees nothing new.
// Signed out → guardSpend's 401, and the shell treats any failure as "no toggle".
export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await guardLiveSaved(req);
  if (!guard.ok) return guard.response;
  const allowed = await liveSaveAllowed(guard.user);
  const tables = await liveSaveTablesReady();
  const ready = allowed && tables;
  // Someone who can save has the link anyway; only the other case needs asking.
  const hasSaved = tables && !ready ? await hasSavedLive(guard.user.id) : false;
  return NextResponse.json({ allowed, ready, hasSaved }, { headers: { "Cache-Control": "no-store" } });
}
