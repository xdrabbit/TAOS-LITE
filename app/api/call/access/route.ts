import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import { callVisibleTo } from "@/lib/release";

export const runtime = "nodejs";
export const maxDuration = 10;

// "May this session reach /call?" — asked by the /call page gate for the one
// half of callVisibleTo() the browser cannot answer: CALL_ALLOWLIST_EMAILS,
// the outside test pairs (lib/release.ts). That list is server-only so the
// addresses never ship in the bundle, which means a tester's browser cannot
// recognise its own owner. It asks here.
//
// This route spends nothing, so it validates the token directly rather than
// through guardSpend. It does not DEFEND /call either — the page gate that
// asks it is still a courtesy, and the fence is the same callVisibleTo()
// check on /api/call/realtime, /ice, /relay-status and /usage.
//
// 204 yes, 404 no — the same 404 those routes give, so to anyone who is not
// allowed, /call's API does not exist. Signed-out, bad token, unlisted: all
// 404, never a hint which it was.

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(req);
  if (!callVisibleTo(user?.email ?? null)) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
