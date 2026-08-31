import { NextRequest, NextResponse } from "next/server";
import { callVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";

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
// So the API token stays on the server, and the browser gets a credential
// that expires. Cloudflare checks it when the phone ALLOCATES a relay, not
// continuously, so the TTL has to outlive the call it is minted for (an
// ICE restart mid-call allocates again) — an hour, not the two minutes the
// realtime client secret gets.
//
// ── Why Cloudflare and not Twilio ──────────────────────────────────────────
// Both were in the stack and both mint short-lived credentials from an API.
// Read 2026-08-31:
//
//   Cloudflare Realtime TURN   $0.05/GB egress, first 1,000 GB/month free
//   Twilio Network Traversal   $0.40/GB relayed
//
// Eight times the price, and Cloudflare's free tier covers every call two
// founders will ever place (a relayed video call is ~1 GB/hour — see
// docs/realtime-cost-model.md). Cloudflare also needs no SDK: one POST with
// a bearer token, so package.json does not grow. Twilio would have been the
// answer if the account had already been carrying TURN traffic; it is not.
//
// ── Degrading, rather than breaking ────────────────────────────────────────
// If the Cloudflare variables are absent — which is true of production until
// Tom creates the key — this route still answers 200 with STUN and
// `relay: false`. Today's behaviour is STUN-only, so an unconfigured relay
// must leave /call exactly as good as it is now, never worse. The honest
// signal goes to the UI, which says so on screen rather than pretending.

/** Cloudflare's credential-minting endpoint. `{keyId}` is substituted below. */
const CLOUDFLARE_TURN_URL =
  process.env.CLOUDFLARE_TURN_API_URL?.trim() ||
  "https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers";

/**
 * How long a minted credential stays good for, in seconds.
 *
 * Cloudflare validates it at ALLOCATE time, so this only has to outlive the
 * moment a phone reaches for the relay — but a call that drops onto a new
 * cell tower ICE-restarts and allocates again, an hour in. So: an hour, and
 * a fresh one every time somebody joins a room.
 */
const CREDENTIAL_TTL_SECONDS = (() => {
  const raw = Number(process.env.CLOUDFLARE_TURN_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 60 ? Math.floor(raw) : 3600;
})();

/**
 * The STUN server /call has always used, and the floor this route degrades
 * to. STUN is free and costs nothing to keep alongside TURN: it is what finds
 * the direct path that means no relay bandwidth is spent at all.
 */
const FALLBACK_ICE: RTCIceServerPayload[] = [{ urls: ["stun:stun.l.google.com:19302"] }];

/** The subset of RTCIceServer that survives JSON. */
export interface RTCIceServerPayload {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceResponse {
  iceServers: RTCIceServerPayload[];
  /** True when a TURN relay is among them — the client shows this honestly. */
  relay: boolean;
  ttlSeconds: number;
}

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

function iceJson(body: IceResponse): NextResponse {
  // no-store, always: a credential with an expiry must never be handed to a
  // second caller by a cache that outlives it.
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/** Keep only the fields WebRTC reads, and only if they are the right shape. */
function sanitizeServers(raw: unknown): RTCIceServerPayload[] {
  if (!Array.isArray(raw)) return [];
  const out: RTCIceServerPayload[] = [];
  for (const entry of raw) {
    const server = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(server?.urls) ? server.urls : [server?.urls]).filter(
      (u): u is string => typeof u === "string" && /^(stun|turn)s?:/.test(u)
    );
    if (urls.length === 0) continue;
    out.push({
      urls,
      ...(typeof server.username === "string" ? { username: server.username } : {}),
      ...(typeof server.credential === "string" ? { credential: server.credential } : {})
    });
  }
  return out;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Same gate, same order, same 404 as /api/call/realtime — and for the same
  // reason. Relay bandwidth is money (guardSpend first, per CLAUDE.md), and
  // to anyone who is not a founder this route does not exist.
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!callVisibleTo(email)) return notFound();
  if (!guard.ok) return guard.response;

  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  if (!keyId || !token) {
    // Unconfigured is not an error — it is production as of 2026-08-31.
    console.info("[taos-call-ice] relay=none reason=unconfigured");
    return iceJson({ iceServers: FALLBACK_ICE, relay: false, ttlSeconds: 0 });
  }

  try {
    const res = await fetch(CLOUDFLARE_TURN_URL.replace("{keyId}", encodeURIComponent(keyId)), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ttl: CREDENTIAL_TTL_SECONDS,
        // Tags the credential so Cloudflare's analytics can attribute relay
        // GB to one phone. The opaque Supabase user id, never the email —
        // this is a third party and an email is the one identifier they have
        // no reason to hold.
        ...(guard.user?.id ? { customIdentifier: `taos-${guard.user.id}` } : {})
      }),
      cache: "no-store"
    });

    const payload = (await res.json().catch(() => null)) as { iceServers?: unknown } | null;
    const servers = sanitizeServers(payload?.iceServers);
    const hasRelay = servers.some((s) => s.urls.some((u) => u.startsWith("turn")));

    if (!res.ok || !hasRelay) {
      // A relay that cannot be minted must not take the call down with it —
      // STUN still connects the same wifi-to-wifi pairs it connects today.
      // The log line is how this gets noticed, since the screen still works.
      console.warn(
        `[taos-call-ice] relay=failed status=${res.status} ` +
          `detail=${JSON.stringify(payload ?? {}).slice(0, 200)}`
      );
      return iceJson({ iceServers: FALLBACK_ICE, relay: false, ttlSeconds: 0 });
    }

    console.info(
      `[taos-call-ice] relay=cloudflare servers=${servers.length} ttl=${CREDENTIAL_TTL_SECONDS}s`
    );
    return iceJson({ iceServers: servers, relay: true, ttlSeconds: CREDENTIAL_TTL_SECONDS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.warn(`[taos-call-ice] relay=error detail=${message}`);
    return iceJson({ iceServers: FALLBACK_ICE, relay: false, ttlSeconds: 0 });
  }
}
