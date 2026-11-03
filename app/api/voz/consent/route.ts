import { NextRequest, NextResponse } from "next/server";
import { guardVoz, vozError } from "@/lib/voz/guard";
import { checkAllowance, mintConsentToken, setDeviceCookie, triesLeft, vozLog } from "@/lib/voz/server";

export const runtime = "nodejs";

// POST /api/voz/consent — the "Acepto · I agree" tap.
//
// Mints the consent token the clone route insists on, and answers the
// question the stranger needs answered BEFORE they talk for a minute: is
// there a try left today? Spends nothing — no provider is called here.
//
// Sets the device cookie on first visit, so the clone request that follows
// is bound to the same device the consent was given on.

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await guardVoz(req);
  if (!gate.ok) return gate.response;
  const { caller } = gate;

  const refusal = checkAllowance(caller);
  if (refusal) {
    vozLog({ event: "refused", reason: refusal.code, tier: caller.tier, at: "consent" });
    const res = vozError(refusal.error, refusal.status, refusal.code);
    setDeviceCookie(res, caller.device);
    return res;
  }

  const { token, expiresAt } = mintConsentToken(caller.owner);
  const res = NextResponse.json(
    { token, expiresAt, triesLeft: triesLeft(caller), tier: caller.tier },
    { headers: { "Cache-Control": "no-store" } }
  );
  setDeviceCookie(res, caller.device);
  return res;
}
