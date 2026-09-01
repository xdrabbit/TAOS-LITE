import { NextRequest, NextResponse } from "next/server";
import { costLogLine, emptySpend, type CallSpend } from "@/lib/call/cost";
import { callVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";

export const runtime = "nodejs";
export const maxDuration = 10;

// Where a finished call writes down what it cost.
//
// The meter itself lives on the phone (lib/call/cost.ts, fed by the usage
// object on every response.done), because that is the only place that sees
// both halves of the bill: the realtime tokens AND the characters handed to
// /api/tts. But a number on a screen that gets closed is a number nobody can
// look up next week, and "what does a minute of /call cost?" was exactly the
// question nobody could answer after the July spikes.
//
// So the phone posts its tally at hang-up and this writes ONE line to the
// Vercel runtime log for project taos-lite:
//
//     vercel logs taos-lite | grep taos-call-cost
//
// It spends nothing, which is the point — it is the only route in /call that
// can be called freely without a provider on the other side. It still takes
// a founder's token, because a stranger who could post here could fill the
// log with invented calls and make the one honest number unfindable.

interface UsageBody {
  room?: string;
  mode?: string;
  direction?: string;
  seconds?: number;
  spend?: Partial<CallSpend>;
  /** How many captions the screen actually put up. See costLogLine. */
  captions?: number;
}

function num(value: unknown, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(Math.max(0, n), max);
}

/**
 * Anything from the phone that ends up in the log line, reduced to characters
 * that cannot forge a second log line out of one. Room codes are 5 characters
 * from an unambiguous alphabet; a direction is "es->en".
 */
function safeLabel(value: unknown, max = 12): string {
  return typeof value === "string"
    ? value.replace(/[^0-9A-Za-z>-]/g, "").slice(0, max) || "?"
    : "?";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!callVisibleTo(email)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as UsageBody;
  const incoming = body.spend ?? {};

  // Rebuilt field by field rather than trusted wholesale: this ends up in a
  // log line that Tom reads as fact, so a phone with a bad clock or a bad
  // build cannot write "usd=99999" into it. The ceilings are absurd-call
  // sized — an hour is the API's own session limit.
  const spend: CallSpend = {
    ...emptySpend(incoming.ttsEngine === "openai" ? "openai" : "elevenlabs"),
    responses: num(incoming.responses, 5000),
    textInTokens: num(incoming.textInTokens, 5_000_000),
    cachedTextInTokens: num(incoming.cachedTextInTokens, 5_000_000),
    audioInTokens: num(incoming.audioInTokens, 5_000_000),
    cachedAudioInTokens: num(incoming.cachedAudioInTokens, 5_000_000),
    textOutTokens: num(incoming.textOutTokens, 1_000_000),
    audioOutTokens: num(incoming.audioOutTokens, 5_000_000),
    transcribedSeconds: num(incoming.transcribedSeconds, 3600),
    ttsCharacters: num(incoming.ttsCharacters, 1_000_000)
  };

  console.info(
    costLogLine({
      room: safeLabel(body.room),
      mode: body.mode === "instant" ? "instant" : "clone",
      direction: safeLabel(body.direction),
      seconds: num(body.seconds, 4 * 3600),
      spend,
      captions: num(body.captions, 100_000)
    })
  );

  // Nothing to say back. The phone is hanging up; it is not waiting on this.
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
