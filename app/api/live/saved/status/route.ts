import { NextRequest, NextResponse } from "next/server";
import { guardLiveSaved, liveSaveAllowed } from "@/lib/live/saveAccess";
import { liveSaveTablesReady } from "@/lib/live/savedStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET /api/live/saved/status → { allowed, ready }
//
// What /live asks once, at mount, to decide what to do with the "Save this
// conversation" toggle:
//   allowed:false            → no toggle at all (not in TAOS_LIVE_SAVE's audience)
//   allowed:true,ready:false → toggle shown disabled, with a hint (the
//                              migration has not been applied yet)
//   allowed:true,ready:true  → the toggle works
// Signed out → guardSpend's 401, and the shell treats any failure as "no toggle".
export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await guardLiveSaved(req);
  if (!guard.ok) return guard.response;
  const allowed = await liveSaveAllowed(guard.user);
  const ready = allowed ? await liveSaveTablesReady() : false;
  return NextResponse.json({ allowed, ready }, { headers: { "Cache-Control": "no-store" } });
}
