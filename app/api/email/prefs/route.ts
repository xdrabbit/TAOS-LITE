import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import { noteVisit, readPrefs, setPrefs, type PrefsPayload } from "@/lib/email/prefsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The daily reminder's settings, for the signed-in person asking
// (lib/email/prefsApi.ts has the shapes and the rules).
//
// Not a spend route: nothing here calls a paid provider. Turning the toggle
// on stores a row; the email itself goes out from the cron, hours later.
// Signed-in only, and a caller only ever reaches their OWN row — the user id
// comes from the verified token, never from the body.

function json(payload: PrefsPayload | { error: string }, status = 200): NextResponse {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(req);
  if (!user) return json({ error: "Please sign in." }, 401);
  return json(await readPrefs(user));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(req);
  if (!user) return json({ error: "Please sign in." }, 401);
  const raw: unknown = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return json({ error: "Bad request." }, 400);
  const body = raw as Record<string, unknown>;
  if (body.action === "visit") return json(await noteVisit(user, body));
  if (body.action === "set") return json(await setPrefs(user, body));
  return json({ error: "Bad request." }, 400);
}
