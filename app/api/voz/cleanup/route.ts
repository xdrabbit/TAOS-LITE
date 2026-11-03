import { NextRequest, NextResponse } from "next/server";
import { notFound, vozError } from "@/lib/voz/guard";
import { deleteVozVoice, kickVozSweep, readVoiceToken, vozEnabled } from "@/lib/voz/server";

export const runtime = "nodejs";

// POST /api/voz/cleanup — delete one voz voice NOW.
//
// Called by "Listo · Done" (fetch, keepalive) and by navigator.sendBeacon on
// page unload. Authenticated by the signed voice token, not a session: a
// beacon carries no Authorization header, and the stranger has no session
// anyway. The worst a replayed token can do is delete a voice that was going
// to be deleted within ten minutes. Expiry is deliberately NOT checked — a
// late "Done" must still delete.

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!vozEnabled()) return notFound();
  let body: { voiceId?: unknown; token?: unknown; reason?: unknown } = {};
  try {
    body = JSON.parse(await req.text()) as typeof body;
  } catch {
    return vozError("Expected JSON.", 400);
  }
  const payload = readVoiceToken(body.token);
  if (!payload || typeof body.voiceId !== "string" || payload.v !== body.voiceId) {
    return vozError("Not a voz voice.", 403);
  }
  kickVozSweep();
  const reason = body.reason === "unload" ? "unload" : "done";
  const gone = await deleteVozVoice(payload.v, reason);
  return NextResponse.json({ deleted: gone }, { status: gone ? 200 : 502 });
}
