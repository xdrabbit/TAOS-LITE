// The door every /api/walkie route walks through, in order — the same three
// steps as lib/demo/guard.ts, because the fence is the same shape:
//
//   1. the flag      — TAOS_WALKIE_ENABLED unset → 404, before anything else
//   2. guardSpend    — no valid session → 401 (lib/spendGuard.ts, unweakened)
//   3. the founder   — anybody else → 404, the answer /api/fast gives
//
// The 404 for a non-founder is deliberate: a held-back screen's routes do
// not announce themselves to a signed-in stranger with a 403.

import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { guardSpend } from "@/lib/spendGuard";
import { isFounder } from "@/lib/release";
import { walkieEnabled } from "./flag";

export type WalkieGuardResult = { ok: true; user: User } | { ok: false; response: NextResponse };

export function walkieNotFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export async function guardWalkie(req: Request): Promise<WalkieGuardResult> {
  if (!walkieEnabled()) return { ok: false, response: walkieNotFound() };
  const guard = await guardSpend(req);
  if (!guard.ok) return guard;
  const user = guard.user;
  if (!user || !isFounder(user.email)) return { ok: false, response: walkieNotFound() };
  return { ok: true, user };
}
