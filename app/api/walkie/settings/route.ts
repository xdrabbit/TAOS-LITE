import { NextRequest, NextResponse } from "next/server";
import { guardWalkie } from "@/lib/walkie/guard";
import { readWalkieNotifyText, writeWalkieNotifyText, WalkieStoreError } from "@/lib/walkie/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET  /api/walkie/settings            → { notifyText: boolean }
// POST /api/walkie/settings { notifyText } → the same, saved
//
// "Show message text in notifications", default ON (Tom, 2026-11-01). Stored
// with the user on profiles. INERT today: there is no web push in the PWA
// (no service worker, no subscription — see the PR body), so nothing reads
// this yet. It is built now so the day push exists the setting is already
// the user's to turn off.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await guardWalkie(req);
  if (!guard.ok) return guard.response;
  try {
    const notifyText = await readWalkieNotifyText(guard.user.id);
    return NextResponse.json({ notifyText }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof WalkieStoreError ? error.code : "failed";
    console.error(`[taos-walkie] settings_failed code=${code}`);
    return NextResponse.json({ error: "Could not read the setting." }, { status: 502 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardWalkie(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => ({}))) as { notifyText?: unknown };
  if (typeof body.notifyText !== "boolean") {
    return NextResponse.json({ error: "notifyText must be true or false." }, { status: 400 });
  }
  try {
    await writeWalkieNotifyText(guard.user.id, body.notifyText);
    return NextResponse.json({ notifyText: body.notifyText }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof WalkieStoreError ? error.code : "failed";
    console.error(`[taos-walkie] settings_failed code=${code}`);
    return NextResponse.json({ error: "Could not save the setting." }, { status: 502 });
  }
}
