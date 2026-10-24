import { NextRequest, NextResponse } from "next/server";
import { notFound } from "@/lib/demo/guard";
import { demoEnabled, sweepDemoVoices } from "@/lib/demo/server";
import { guardSpend } from "@/lib/spendGuard";
import { isFounder } from "@/lib/release";

export const runtime = "nodejs";
export const maxDuration = 60;
// Without this Next 14 prerenders a GET handler at build time — and would
// serve the build machine's 404 forever.
export const dynamic = "force-dynamic";

// GET /api/demo/sweep — founders only. Delete every `taos-demo-*` voice older
// than ten minutes, and say what happened. The same sweep starts on every
// other /api/demo request; this is the one Tom can trigger by hand, and the
// one that WAITS, so its answer is the truth about the account.
//
// Not through guardDemo(): that kicks off a background sweep, and this route
// is the sweep.

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!demoEnabled()) return notFound();
  const guard = await guardSpend(req);
  if (!guard.ok) return guard.response;
  if (!isFounder(guard.user?.email)) return notFound();

  const result = await sweepDemoVoices();
  return NextResponse.json(result, {
    status: result.listError ? 502 : 200,
    headers: { "Cache-Control": "no-store" }
  });
}
