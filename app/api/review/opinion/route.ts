import { NextRequest, NextResponse } from "next/server";
import { guardReview } from "@/lib/review/guard";
import { explainLanguage } from "@/lib/review/opinion";
import { runSecondOpinion } from "@/lib/review/secondOpinion";
import { ReviewStoreError } from "@/lib/review/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/review/opinion { id, explain?: "en" | "es" | … } → { turn }
//
// One turn's second opinion, on demand (Tom, 2026-11-04 20:27 MT): a second
// transcriber reads the clip and a grader reads the translation; both land
// on the row (lib/review/secondOpinion.ts). `explain` is the language the
// grader writes its one-line reasons in — the reviewer's chrome language.
//
// guardReview first: guardSpend (401 bare) then founders only (404). The
// provider is never reached before that answer.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardReview(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; explain?: unknown };
  if (typeof body.id !== "string" || !UUID.test(body.id)) {
    return NextResponse.json({ error: "id must be a turn id." }, { status: 400 });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server misconfiguration: missing OPENAI_API_KEY." }, { status: 500 });
  }
  try {
    const turn = await runSecondOpinion(body.id, { apiKey }, explainLanguage(body.explain));
    if (!turn) return NextResponse.json({ error: "That turn is gone." }, { status: 404 });
    return NextResponse.json({ turn }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof ReviewStoreError ? error.code : "failed";
    console.error(`[taos-review] opinion_failed code=${code}`);
    return NextResponse.json({ error: "Could not get a second opinion." }, { status: 502 });
  }
}
