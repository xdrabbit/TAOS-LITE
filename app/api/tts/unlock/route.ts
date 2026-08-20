import { NextRequest, NextResponse } from "next/server";
import { personalVoiceUnlocked } from "@/lib/tts/personalVoice";

export const runtime = "nodejs";

// Checks a typed personal-voice code so the unlock sheet can say "that worked"
// instead of leaving Tom to guess from the voice that comes back. It is only a
// convenience: /api/tts re-checks the code on every request, so nothing here
// grants access on its own.
//
// The reply is a bare boolean — no echo of the code, no distinction between
// "wrong code" and "TAOS_PERSONAL_VOICE_CODE isn't set", so a prober learns
// nothing beyond yes/no. Keep the secret long and random; there is no rate
// limit in front of this.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { code?: string };
  const ok = personalVoiceUnlocked(
    typeof body.code === "string" ? body.code : null,
    process.env.TAOS_PERSONAL_VOICE_CODE
  );
  return NextResponse.json({ ok }, { headers: { "Cache-Control": "no-store" } });
}
