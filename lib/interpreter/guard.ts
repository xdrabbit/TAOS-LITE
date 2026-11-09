// The door every /api/tabletop/interpreter route walks through, in order —
// the same three steps as lib/walkie/guard.ts, because the fence is the same
// shape:
//
//   1. the flag      — TAOS_INTERPRETER_ENABLED unset → 404, before anything
//   2. guardSpend    — no valid session → 401 (lib/spendGuard.ts, unweakened)
//   3. the founder   — anybody else → 404
//
// The 404 for a non-founder is deliberate: a held-back mode's routes do not
// announce themselves to a signed-in stranger with a 403.

import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { guardSpend } from "@/lib/spendGuard";
import { isFounder } from "@/lib/release";
import { interpreterEnabled } from "./flag";

export type InterpreterGuardResult =
  | { ok: true; user: User }
  | { ok: false; response: NextResponse };

export function interpreterNotFound(): NextResponse {
  return NextResponse.json(
    { error: "Not found." },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

export async function guardInterpreter(req: Request): Promise<InterpreterGuardResult> {
  if (!interpreterEnabled()) return { ok: false, response: interpreterNotFound() };
  const guard = await guardSpend(req);
  if (!guard.ok) return guard;
  const user = guard.user;
  if (!user || !isFounder(user.email)) return { ok: false, response: interpreterNotFound() };
  return { ok: true, user };
}
