import { NextRequest, NextResponse } from "next/server";
import { callVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { mintTurnServers } from "@/lib/call/turnMint";
import type { RelayStatus, RTCIceServerPayload } from "@/lib/call/relay";

export const runtime = "nodejs";
export const maxDuration = 15;

// Mints the ICE servers a /call peer connection is built with — short-lived
// TURN credentials from Cloudflare Realtime, plus STUN.
//
// ── Why this route exists ──────────────────────────────────────────────────
// Field report 2026-08-31: Tom and Liz, both founders, both seeing /call, the
// call initiating — and no connection, phone to phone. This is the leg the
// /call build flagged as unverified and lib/release.ts still describes as
// "never met a stranger's carrier NAT".
//
// It had never met one because there was nothing for it to fall back TO.
// lib/call/session.ts asked for one public Google STUN server and nothing
// else. STUN only tells a phone its own public address; it cannot carry a
// packet. When both ends sit behind carrier-grade NAT — two phones on
// cellular, which is exactly the pair that fails — every candidate the two
// sides exchange is unreachable from the other, ICE runs out of pairs, and
// the call sits in "connecting" forever. No amount of retrying fixes it: the
// path does not exist. A relay is the only thing that makes it exist.
//
// ── Why the credentials are minted here and not bundled ────────────────────
// A TURN credential is a bandwidth credit. Anything shipped in the browser
// bundle is public (NEXT_PUBLIC_* is inlined at build time and readable by
// anyone with view-source), so static TURN credentials in the client are a
// free relay for the whole internet, billed to Tom. The old
// NEXT_PUBLIC_TURN_* path this replaces had exactly that shape — it was never
// configured, which is the only reason it never cost anything.
//
// The mint itself now lives in lib/call/turnMint.ts, because
// /api/call/relay-status asks Cloudflare the same question and throws the
// credential away. See that file for the TTL and the Cloudflare-vs-Twilio
// arithmetic that used to be written out here.
//
// ── Degrading, rather than breaking ────────────────────────────────────────
// If the mint fails for any reason — no keys, wrong keys, Cloudflare down —
// this route still answers 200 with STUN and `relay: false`. Pre-relay
// behaviour was STUN-only, so a broken relay must leave /call exactly as good
// as it is now, never worse. The honest signal goes to the UI, which says so
// on screen rather than pretending; `status` is the same word
// /api/call/relay-status uses, so a call that started badly and a lobby
// indicator cannot disagree about why.

export type { RTCIceServerPayload };

export interface IceResponse {
  iceServers: RTCIceServerPayload[];
  /** True when a TURN relay is among them — the client shows this honestly. */
  relay: boolean;
  ttlSeconds: number;
  /** Why, when `relay` is false. Same vocabulary as /api/call/relay-status. */
  status: RelayStatus;
}

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Same gate, same order, same 404 as /api/call/realtime — and for the same
  // reason. Relay bandwidth is money (guardSpend first, per CLAUDE.md), and
  // to anyone who is not a founder this route does not exist.
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!callVisibleTo(email)) return notFound();
  if (!guard.ok) return guard.response;

  const mint = await mintTurnServers(guard.user?.id ?? null);
  const relay = mint.status === "ready";

  // One log line per mint, greppable in Vercel runtime logs under the same
  // prefix the browser console uses, so a founder's screenshot and the server
  // read as one story. The HTTP status is the diagnostic that matters: a 401
  // here is the difference between "Tom has not made the key yet" and "the
  // key Tom made is wrong", which is a question nobody could answer from a
  // phone before 2026-08-31.
  const log = relay ? console.info : console.warn;
  log(
    `[taos-call-ice] relay=${mint.status} servers=${mint.iceServers.length} ` +
      `http=${mint.httpStatus ?? "none"} ttl=${mint.ttlSeconds}s` +
      (mint.detail ? ` detail=${mint.detail}` : "")
  );

  // no-store, always: a credential with an expiry must never be handed to a
  // second caller by a cache that outlives it.
  return NextResponse.json(
    {
      iceServers: mint.iceServers,
      relay,
      ttlSeconds: mint.ttlSeconds,
      status: mint.status
    } satisfies IceResponse,
    { headers: { "Cache-Control": "no-store" } }
  );
}
