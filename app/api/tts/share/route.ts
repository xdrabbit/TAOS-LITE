import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";

export const runtime = "nodejs";

// One `[taos-share]` line per tap on the home card's Share (Tom, 2026-10-24):
// did the share sheet take it, did it fall back to a download, or did the
// person back out — and was the file signed. taos_lite_tts_log's `status`
// column is CHECKed to ok|error, so this is a log line rather than a row;
// no migration.
//
// Nothing that identifies the person or what they said: no text, no email,
// no User-Agent, no user id. Signed-in callers only, so the count is ours.

const RESULTS = new Set(["shared", "downloaded", "cancelled"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(req).catch(() => null);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    result?: unknown;
    lang?: unknown;
    signoff?: unknown;
    subscriber?: unknown;
  };
  if (typeof body.result !== "string" || !RESULTS.has(body.result)) {
    return NextResponse.json({ error: "Unknown result." }, { status: 400 });
  }
  const lang =
    typeof body.lang === "string" ? body.lang.replace(/[^0-9A-Za-z-]/g, "").slice(0, 12) || "?" : "?";
  console.log(
    `[taos-share] result=${body.result} lang=${lang} signoff=${body.signoff === true ? 1 : 0} ` +
      `subscriber=${body.subscriber === true ? 1 : 0}`
  );
  return new NextResponse(null, { status: 204 });
}
