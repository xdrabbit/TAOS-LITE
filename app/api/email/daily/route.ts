import { NextRequest, NextResponse } from "next/server";
import { trustedOrigin } from "@/lib/authRedirect";
import { runDailyEmails } from "@/lib/email/daily";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET /api/email/daily — the hourly pass of the daily study reminder
// (lib/email/daily.ts says what one pass does, and in what order).
//
// ONE caller: Vercel Cron, every hour on the hour (vercel.json), which sends
// CRON_SECRET as a Bearer token exactly as /api/walkie/sweep expects it. And
// like the sweep, this does NOT run open when CRON_SECRET is unset — a route
// that sends email with no credential is not something any deployment should
// carry. No secret, no run. There is no founder-by-hand path: nobody should
// be able to make this send by visiting a URL.
//
// Hourly because "8 in the morning" is a different UTC hour for every person;
// each run sends only to the people whose own clock says it is time. It is
// safe to fire twice and safe to skip (the claim and the catch-up window).
//
// Always 200 when authorised, whatever the state — off, inert (a missing env
// var, named in one log line), no table yet, or ran. A cron that 500s because
// the feature is switched off is noise in the one place failures get noticed.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization") ?? "";
  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const result = await runDailyEmails({ origin: trustedOrigin(new URL(req.url).origin) });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
