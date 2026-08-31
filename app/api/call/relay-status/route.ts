import { NextRequest, NextResponse } from "next/server";
import { callVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { mintTurnServers } from "@/lib/call/turnMint";
import type { RelayStatusReport } from "@/lib/call/relay";

export const runtime = "nodejs";
export const maxDuration = 15;

// Is the relay alive? Asked from the lobby, before anyone dials.
//
// ── The loop this closes ───────────────────────────────────────────────────
// PR #52 shipped the relay dark: production had no CLOUDFLARE_TURN_KEY_ID, so
// /api/call/ice degraded to STUN and said `relay: false`. Tom entered both
// Cloudflare variables on 2026-08-31 and redeployed — and the only instrument
// anyone had for finding out whether they took was to place a real call to
// Liz, on two real phones, in two rooms, and see whether it connected. Every
// test of the relay since it shipped has been that call. It has never once
// been observed working.
//
// The reason a call is a bad instrument is that it fails for five reasons at
// once and reports one word. This route asks the single question the keys are
// responsible for — will Cloudflare mint a credential for us RIGHT NOW — and
// answers in the four words of lib/call/relay.ts. `rejected` is the one that
// justifies the route: it means the keys are present and wrong, which
// `relay: false` could never say, and which is a two-minute fix in Vercel
// that nobody could know to make.
//
// ── Why it mints for real ──────────────────────────────────────────────────
// Checking that the variables are non-empty would be free and would prove
// nothing: a typo'd token is non-empty. Cloudflare validates the token at
// MINT time and the credential at ALLOCATE time, so this route can prove the
// first half and only the client loopback (lib/call/relayProbe.ts) can prove
// the second. Both halves are in the lobby, one automatic and one a tap,
// because they fail independently: a key that mints can still be refused an
// allocation.
//
// ── What it does not return ────────────────────────────────────────────────
// The credential. It is minted and dropped on the floor. A status check is
// safe to run whenever a lobby renders; a credential handed out whenever a
// lobby renders is a credential handed to whoever is watching. Real ones come
// from POST /api/call/ice, once, at join. tests/call-relay-status.test.ts
// fences the response body against every secret this route can see.

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Founders only, refused before Cloudflare is called — the same gate and
  // the same order as /api/call/ice. This route mints a real credential, so a
  // 404 issued afterwards would be the same bandwidth grant with better
  // manners.
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!callVisibleTo(email)) return notFound();
  if (!guard.ok) return guard.response;

  const mint = await mintTurnServers(guard.user?.id ?? null);

  const log = mint.status === "ready" ? console.info : console.warn;
  log(
    `[taos-call-ice] preflight relay=${mint.status} http=${mint.httpStatus ?? "none"}` +
      (mint.detail ? ` detail=${mint.detail}` : "")
  );

  return NextResponse.json(
    {
      status: mint.status,
      ttlSeconds: mint.ttlSeconds,
      httpStatus: mint.httpStatus,
      detail: mint.detail
    } satisfies RelayStatusReport,
    { headers: { "Cache-Control": "no-store" } }
  );
}
