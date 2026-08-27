import { NextRequest, NextResponse } from "next/server";
import {
  LEAD_BAD_EMAIL,
  LEAD_RATE_LIMITED,
  LEAD_THANKS,
  isValidLeadEmail,
  normalizeLeadEmail,
  normalizeLeadSource
} from "@/lib/leads";
import { callerIp, fromTrustedOrigin, hit } from "@/lib/spendGuard";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 15;

// The only way into `taos_leads` now.
//
// The table used to take writes straight from the internet: one policy,
// INSERT for {anon, authenticated} with `with check (true)`, satisfied by the
// publishable key that ships in every browser bundle. A real POST with that
// key and `Prefer: return=minimal` came back 201 Created — verified, then
// closed, in supabase/migrations/20260826_leads_server_only.sql. The table has
// no policies at all now, so the service role is the only writer, and this
// route is the only thing holding it.
//
// ── What this route is, honestly ───────────────────────────────────────────
// Nothing in this app calls it. `taos_leads` has one row (the owner's own
// address, June 20) and a `source` column defaulting to 'atom' — a different
// app's name — and no call site anywhere on the machine. So this is not a
// feature being restored; it is the door left in the wall, so that closing
// the hole in the wall does not mean lead capture becomes impossible. If a
// landing page ever wants to collect an address again, it posts here.
//
// ── The three fences ───────────────────────────────────────────────────────
// Same three, in the same order, as the anonymous path in lib/spendGuard.ts,
// and worth exactly what they are worth there:
//
//   1. Origin — a request with no Origin and no Referer is not a browser on
//      one of our pages. This is the bare-curl fence, and it is forgeable by
//      anyone who reads this file. Note the consequence: a page on some OTHER
//      domain cannot post here until its origin is added to the allow-list in
//      lib/authRedirect.ts. That is a deliberate trade for a route whose job
//      is to be written to by strangers.
//   2. Rate limit — per IP, then globally, in module-scope buckets. Fixed
//      window, per instance, lost on a cold start. It bounds a script to a
//      trickle; it does not stop a determined one.
//   3. Validation — shape only (lib/leads.ts), because the only real proof
//      that an address exists is mail arriving at it.
//
// What they add up to: the table is no longer writable by everyone, and what
// does reach it is bounded and shaped. That is the whole claim.

/** Per IP. A person signs up once; a handful covers fat fingers and retries. */
const LEADS_PER_HOUR = 5;
/** Everyone this instance sees, together. The blast-radius cap. */
const LEADS_GLOBAL_PER_HOUR = 100;

const HOUR_MS = 3_600_000;

// Its own buckets rather than spendGuard's: those are sized for a /try funnel
// that runs a couple of calls per translation, and a signup form borrowing
// that budget would let one script lock translation out of its allowance.
const leadBuckets = new Map<string, { count: number; resetAt: number }>();

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!fromTrustedOrigin(req)) {
    return NextResponse.json({ error: LEAD_BAD_EMAIL }, { status: 403 });
  }
  if (!hasServiceRoleKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY." },
      { status: 500 }
    );
  }

  const now = Date.now();
  // Short-circuit on the first limit that trips, so one IP hammering its own
  // window does not also drain the shared one — the same reasoning as
  // guardSpend, and the same outage it exists to prevent rather than cause.
  if (!hit(leadBuckets, `lead:ip:${callerIp(req)}`, LEADS_PER_HOUR, HOUR_MS, now)) {
    return NextResponse.json({ error: LEAD_RATE_LIMITED }, { status: 429 });
  }
  if (!hit(leadBuckets, "lead:global", LEADS_GLOBAL_PER_HOUR, HOUR_MS, now)) {
    return NextResponse.json({ error: LEAD_RATE_LIMITED }, { status: 429 });
  }

  const payload = (await req.json().catch(() => ({}))) as { email?: unknown; source?: unknown };
  const email = normalizeLeadEmail(payload.email);
  if (!isValidLeadEmail(email)) {
    return NextResponse.json({ error: LEAD_BAD_EMAIL }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("taos_leads")
    .insert({ email, source: normalizeLeadSource(payload.source) });
  if (error) {
    // Never echo the database's complaint: it names columns and constraints,
    // and this is the one route in the app a stranger is invited to POST to.
    return NextResponse.json({ error: "Could not save that. Try again." }, { status: 502 });
  }

  return NextResponse.json({ ok: true, message: LEAD_THANKS });
}
