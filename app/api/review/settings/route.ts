import { NextRequest, NextResponse } from "next/server";
import { guardReview } from "@/lib/review/guard";
import { readReviewKeepAudio, writeReviewKeepAudio, ReviewStoreError } from "@/lib/review/store";
import { reviewRetentionDays } from "@/lib/review/flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET  /api/review/settings              → { keepAudio, retentionDays }
// POST /api/review/settings { keepAudio } → the same, saved
//
// "Keep my audio for review", default OFF (Tom, 2026-11-04). Stored with the
// user on profiles.review_keep_audio. The caller can only ever read and
// write their OWN row: the user id comes from the validated session, never
// from the body, so one founder cannot flip it for the other.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await guardReview(req);
  if (!guard.ok) return guard.response;
  try {
    const keepAudio = await readReviewKeepAudio(guard.user.id);
    return NextResponse.json(
      { keepAudio, retentionDays: reviewRetentionDays() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const code = error instanceof ReviewStoreError ? error.code : "failed";
    console.error(`[taos-review] settings_failed code=${code}`);
    return NextResponse.json({ error: "Could not read the setting." }, { status: 502 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardReview(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => ({}))) as { keepAudio?: unknown };
  if (typeof body.keepAudio !== "boolean") {
    return NextResponse.json({ error: "keepAudio must be true or false." }, { status: 400 });
  }
  try {
    await writeReviewKeepAudio(guard.user.id, body.keepAudio);
    console.log(`[taos-review] keep_audio=${body.keepAudio ? 1 : 0}`);
    return NextResponse.json(
      { keepAudio: body.keepAudio, retentionDays: reviewRetentionDays() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const code = error instanceof ReviewStoreError ? error.code : "failed";
    console.error(`[taos-review] settings_failed code=${code}`);
    return NextResponse.json({ error: "Could not save the setting." }, { status: 502 });
  }
}
