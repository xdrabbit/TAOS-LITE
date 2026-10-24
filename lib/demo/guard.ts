// The door every founder-session /api/demo route walks through, in order:
//
//   1. the flag      — TAOS_DEMO_ENABLED unset → 404, before anything else
//   2. guardSpend    — no valid session → 401 (lib/spendGuard.ts, unweakened)
//   3. the founder   — anybody else → 404, the answer /api/fast gives
//   4. the sweep     — kicked off, not awaited (lib/demo/server.ts)
//
// The sweep runs AFTER the founder check on purpose: a stranger's curl must
// not be able to make this server call ElevenLabs, even to list voices.
//
// /api/demo/cleanup does not come through here. It is reached by
// navigator.sendBeacon on page unload, which cannot carry an Authorization
// header, so it authenticates with the signed demo token instead.

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import type { User } from "@supabase/supabase-js";
import { guardSpend } from "@/lib/spendGuard";
import { isFounder } from "@/lib/release";
import { demoEnabled, sweepDemoVoices } from "./server";

export type DemoGuardResult = { ok: true; user: User } | { ok: false; response: NextResponse };

export function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/** Start a sweep without making the caller wait for it. Never throws. */
export function kickSweep(): void {
  try {
    waitUntil(sweepDemoVoices().catch(() => undefined));
  } catch {
    // Outside a Vercel request context (tests, local) the promise still runs.
  }
}

export async function guardDemo(req: Request): Promise<DemoGuardResult> {
  if (!demoEnabled()) return { ok: false, response: notFound() };
  const guard = await guardSpend(req);
  if (!guard.ok) return guard;
  const user = guard.user;
  if (!user || !isFounder(user.email)) return { ok: false, response: notFound() };
  kickSweep();
  return { ok: true, user };
}
