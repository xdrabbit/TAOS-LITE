import { NextRequest, NextResponse } from "next/server";
import { guardLiveSaved, liveSaveAllowed } from "@/lib/live/saveAccess";
import {
  LiveSavedError,
  liveSaveTablesReady,
  parseLiveSaveRequest,
  saveLiveLine
} from "@/lib/live/savedStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// POST /api/live/saved/lines   { session: {...}, line: {...} }   → { ok: true }
//
// One line of a /live conversation the user chose to save. The phone only
// calls this while its "Save this conversation" toggle is on; this route is
// the half that does not take the phone's word for who may:
//
//   1. signed in                          (guardSpend, unweakened) → else 401
//   2. in the audience TAOS_LIVE_SAVE names (default founders)     → else 404
//   3. the tables exist                                            → else 409 not_ready
//   4. the session id is this user's (or new)                      → else 404
//
// TEXT ONLY — there is no audio in the body and nowhere to put any.
//
// The log line carries ids and counts and nothing else. The text of a
// conversation is never logged, and never echoed back in an error.
const noStore = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardLiveSaved(req);
  if (!guard.ok) return guard.response;
  if (!(await liveSaveAllowed(guard.user))) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  }
  const parsed = parseLiveSaveRequest(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ error: "Bad request." }, { status: 400, headers: noStore });
  if (!(await liveSaveTablesReady())) {
    return NextResponse.json({ error: "not_ready" }, { status: 409, headers: noStore });
  }
  try {
    await saveLiveLine(guard.user.id, parsed);
    console.info(
      `[taos-live-save] line session=${parsed.session.id} seq=${parsed.line.seq} ` +
        `heard_chars=${parsed.line.heard.length} text_chars=${parsed.line.text.length} ` +
        `detect=${parsed.line.detect ?? "na"} auto=${parsed.session.auto ? 1 : 0}`
    );
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (error) {
    const code = error instanceof LiveSavedError ? error.code : "failed";
    console.error(`[taos-live-save] line_failed session=${parsed.session.id} seq=${parsed.line.seq} code=${code}`);
    if (code === "not_yours") return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
    return NextResponse.json({ error: "Could not save." }, { status: 502, headers: noStore });
  }
}
