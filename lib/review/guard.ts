// The door every /api/review route walks through, in order — lib/walkie/
// guard.ts without the flag step, because review has no flag:
//
//   1. guardSpend   — no valid session → 401 (lib/spendGuard.ts, unweakened)
//   2. the founder  — anybody else → 404, the answer /api/fast gives
//
// The 404 for a non-founder is deliberate: a founders-only screen's routes
// do not announce themselves to a signed-in stranger with a 403.

import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { guardSpend } from "@/lib/spendGuard";
import { reviewVisibleTo } from "./flag";

export type ReviewGuardResult = { ok: true; user: User } | { ok: false; response: NextResponse };

export function reviewNotFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export async function guardReview(req: Request): Promise<ReviewGuardResult> {
  const guard = await guardSpend(req);
  if (!guard.ok) return guard;
  const user = guard.user;
  if (!user || !reviewVisibleTo(user.email)) return { ok: false, response: reviewNotFound() };
  return { ok: true, user };
}
