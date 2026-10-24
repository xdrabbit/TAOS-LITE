import { NextRequest, NextResponse } from "next/server";
import { kickSweep, notFound } from "@/lib/demo/guard";
import { deleteDemoVoice, demoEnabled, readDemoToken } from "@/lib/demo/server";

export const runtime = "nodejs";

// POST /api/demo/cleanup — delete one demo voice NOW.
//
// Called two ways: by "Terminar · Done" (fetch, keepalive) and by
// navigator.sendBeacon when the page unloads. A beacon cannot carry an
// Authorization header, so this route does not ask for a session: it asks for
// the signed demo token the clone route minted, which proves the caller holds
// the voice it is asking to delete. The worst a replayed token can do is
// delete a voice that was going to be deleted anyway.
//
// Body is JSON `{ voiceId, token, reason }`, sent as text/plain by the beacon.
// The token's expiry is deliberately NOT checked — a late "Done" must still
// delete.

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!demoEnabled()) return notFound();

  let body: { voiceId?: unknown; token?: unknown; reason?: unknown } = {};
  try {
    body = JSON.parse(await req.text()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }
  const payload = readDemoToken(body.token);
  if (!payload || typeof body.voiceId !== "string" || payload.v !== body.voiceId) {
    return NextResponse.json({ error: "Not a demo voice." }, { status: 403 });
  }

  kickSweep();
  const reason = body.reason === "unload" ? "unload" : "done";
  const gone = await deleteDemoVoice(payload.v, reason);
  return NextResponse.json({ deleted: gone }, { status: gone ? 200 : 502 });
}
