import { NextRequest, NextResponse } from "next/server";
import { notFound, vozError } from "@/lib/voz/guard";
import { readVoiceToken, vozEnabled, vozLog } from "@/lib/voz/server";

export const runtime = "nodejs";

// POST /api/voz/share — one `[taos-voz] event=share` line, nothing else.
//
// The share itself happens on the phone (the share sheet); this is how the
// server learns it happened, so the funnel can be read from the logs. Same
// token as cleanup; no audio, no text, no name. Spends nothing.

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!vozEnabled()) return notFound();
  let body: { voiceId?: unknown; token?: unknown; outcome?: unknown } = {};
  try {
    body = JSON.parse(await req.text()) as typeof body;
  } catch {
    return vozError("Expected JSON.", 400);
  }
  const payload = readVoiceToken(body.token);
  if (!payload || payload.v !== body.voiceId) return vozError("Not a voz voice.", 403);
  const outcome = body.outcome === "downloaded" || body.outcome === "cancelled" ? body.outcome : "shared";
  vozLog({ event: "share", voice: payload.v, outcome });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
