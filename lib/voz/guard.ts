// The door every /api/voz route that can spend walks through, in order:
//
//   1. the flag      — TAOS_VOZ_ENABLED unset → 404, before anything else
//   2. guardSpend    — with allowAnonymous: the SAME origin check and per-IP /
//                      global allowance the /try funnel uses (lib/spendGuard.ts,
//                      unweakened). A signed-in caller passes on their session.
//   3. who           — the account, or the device cookie + an IP/UA hash
//
// The sweep is NOT kicked here: a request has to show a token we signed
// before this server will call ElevenLabs on its behalf, even to list voices.

import { NextResponse, type NextRequest } from "next/server";
import { guardSpend } from "@/lib/spendGuard";
import { identifyCaller, vozEnabled, type VozCaller } from "./server";

export function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export function vozError(error: string, status: number, code?: string): NextResponse {
  return NextResponse.json(code ? { error, code } : { error }, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

export type VozGuardResult = { ok: true; caller: VozCaller } | { ok: false; response: NextResponse };

export async function guardVoz(req: NextRequest): Promise<VozGuardResult> {
  if (!vozEnabled()) return { ok: false, response: notFound() };
  const guard = await guardSpend(req, { allowAnonymous: true });
  if (!guard.ok) return guard;
  return { ok: true, caller: await identifyCaller(req, guard.user) };
}
