import {
  hasRelayServer,
  sanitizeIceServers,
  type RelayStatus,
  type RTCIceServerPayload
} from "./relay";

// Asking Cloudflare for a TURN credential, once, in one place.
//
// This was the body of app/api/call/ice/route.ts until 2026-08-31. It moved
// because a SECOND route now needs to ask the same question and discard the
// answer: /api/call/relay-status reports whether the keys work without
// handing anybody a credential. Two copies of a mint is two places for the
// TTL, the customIdentifier rule, or the sanitiser to drift.
//
// ── Server only ────────────────────────────────────────────────────────────
// Nothing here may reach the browser. `CLOUDFLARE_TURN_API_TOKEN` is a
// bandwidth credit with no expiry; the credentials it mints have one. The
// NEXT_PUBLIC_TURN_* path PR #52 replaced had the token itself inlined in the
// bundle, which is a free relay for anyone who reads view-source, billed to
// Tom. Import this from a route handler and nowhere else.

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
export function credentialTtlSeconds(): number {
  const raw = Number(process.env.CLOUDFLARE_TURN_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 60 ? Math.floor(raw) : 3600;
}

/**
 * The STUN server /call has always used, and the floor a failed mint degrades
 * to. STUN is free and costs nothing to keep alongside TURN: it is what finds
 * the direct path that means no relay bandwidth is spent at all.
 */
export const FALLBACK_ICE: RTCIceServerPayload[] = [
  { urls: ["stun:stun.l.google.com:19302"] }
];

export interface TurnMint {
  status: RelayStatus;
  /** Sanitised and ready to hand a browser. Never empty — STUN is the floor. */
  iceServers: RTCIceServerPayload[];
  /** Only meaningful when `status` is `ready`. */
  ttlSeconds: number;
  /** Cloudflare's HTTP status, when it answered. Diagnosis, never a secret. */
  httpStatus: number | null;
  /** A short, secret-free reason. Safe to put on a founder's screen. */
  detail: string | null;
}

/** Are the Cloudflare variables present at all? Cheap; makes no request. */
export function turnConfigured(): boolean {
  return Boolean(
    process.env.CLOUDFLARE_TURN_KEY_ID?.trim() && process.env.CLOUDFLARE_TURN_API_TOKEN?.trim()
  );
}

/**
 * Mint one short-lived TURN credential set.
 *
 * Never throws. Every failure comes back as a status with STUN attached,
 * because losing the relay must degrade the hard network pairings, not break
 * the easy ones — /call has been making STUN-only calls all along and they
 * connect on the wifi that has always worked.
 *
 * @param userId Opaque Supabase user id, for Cloudflare's usage analytics.
 *   Never an email: this is a third party and an email is the one identifier
 *   they have no reason to hold.
 */
export async function mintTurnServers(userId?: string | null): Promise<TurnMint> {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  const ttlSeconds = credentialTtlSeconds();

  if (!keyId || !token) {
    return {
      status: "not_configured",
      iceServers: FALLBACK_ICE,
      ttlSeconds: 0,
      httpStatus: null,
      detail: !keyId && !token ? "no key id and no api token" : !keyId ? "no key id" : "no api token"
    };
  }

  try {
    const res = await fetch(CLOUDFLARE_TURN_URL.replace("{keyId}", encodeURIComponent(keyId)), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ttl: ttlSeconds,
        ...(userId ? { customIdentifier: `taos-${userId}` } : {})
      }),
      cache: "no-store"
    });

    const payload = (await res.json().catch(() => null)) as { iceServers?: unknown } | null;
    const servers = sanitizeIceServers(payload?.iceServers);

    if (res.ok && hasRelayServer(servers)) {
      return { status: "ready", iceServers: servers, ttlSeconds, httpStatus: res.status, detail: null };
    }

    // A 4xx is the only answer that means a HUMAN has to do something: the
    // key id and the token are a pair, and Cloudflare rejects a wrong one,
    // a swapped one, a revoked one and one belonging to another account with
    // the same shrug. Everything else — 5xx, an empty body, a 2xx carrying
    // only STUN — is Cloudflare having a moment, and retrying is the fix.
    const rejected = res.status >= 400 && res.status < 500;
    return {
      status: rejected ? "rejected" : "error",
      iceServers: FALLBACK_ICE,
      ttlSeconds: 0,
      httpStatus: res.status,
      detail: rejected
        ? cloudflareMessage(payload) ?? `cloudflare refused with HTTP ${res.status}`
        : res.ok
          ? "cloudflare answered without a turn server"
          : `cloudflare answered HTTP ${res.status}`
    };
  } catch (error) {
    return {
      status: "error",
      iceServers: FALLBACK_ICE,
      ttlSeconds: 0,
      httpStatus: null,
      detail: error instanceof Error ? error.message : "unknown"
    };
  }
}

/**
 * Cloudflare's own words for the refusal, when it gave any.
 *
 * Truncated hard, and only ever taken from the documented `errors[].message`
 * shape — never `JSON.stringify(body)`. A minted credential lives in the same
 * response object as an error does, and a blanket stringify of an unexpected
 * body is how one ends up in a log or on a screen.
 */
function cloudflareMessage(payload: unknown): string | null {
  const errors = (payload as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return null;
  const messages = errors
    .map((e) => (e as { message?: unknown })?.message)
    .filter((m): m is string => typeof m === "string");
  return messages.length > 0 ? messages.join("; ").slice(0, 160) : null;
}
