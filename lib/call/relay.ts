// What "the relay" is doing, in one vocabulary both halves of /call speak.
//
// ── Why this file is separate from the two that use it ─────────────────────
// The server mints TURN credentials (lib/call/turnMint.ts) and the browser
// reports on them (components/CallShell.tsx). If the status names lived in
// either one, the other would import a module it must not: a "use client"
// file dragged into a route handler, or a route's env-reading module dragged
// into the bundle. So the names, and the words shown for them, live here —
// no imports, no directive, safe on both sides.
//
// ── Why there is a vocabulary at all ───────────────────────────────────────
// PR #52 shipped the relay with one bit of state: `relay: true | false`. That
// bit cannot tell a founder standing in a kitchen apart:
//
//   - nobody has entered the Cloudflare keys yet          (nothing to do but wait)
//   - the keys are entered and WRONG                      (go fix them in Vercel)
//   - Cloudflare had a bad minute                         (try again)
//
// All three read as "no relay", and all three were indistinguishable from a
// phone. Tom entered CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN on
// 2026-08-31 and redeployed, and the ONLY way anyone had to find out whether
// they took was to place a real call to Liz and see. That is the loop this
// vocabulary exists to break.

/**
 * What the server got back when it asked Cloudflare for a credential.
 *
 * - `ready`          — minted. A TURN server came back and the call has a
 *                      relay to fall back on.
 * - `not_configured` — `CLOUDFLARE_TURN_KEY_ID` / `_API_TOKEN` are absent.
 *                      This was production until 2026-08-31, and it is not an
 *                      error: /call still connects everywhere STUN connects.
 * - `rejected`       — Cloudflare answered 4xx. The keys exist and are wrong,
 *                      swapped, revoked, or scoped to another account. THE
 *                      ONE STATE THAT NEEDS A HUMAN, and the one PR #52 could
 *                      not distinguish from the two above it.
 * - `error`          — 5xx, a network failure, or a 2xx whose body carried no
 *                      TURN server. Nothing is wrong with the keys; try again.
 */
export type RelayStatus = "ready" | "not_configured" | "rejected" | "error";

/** The subset of RTCIceServer that survives JSON, in both directions. */
export interface RTCIceServerPayload {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * What the status endpoint says. Deliberately has no `iceServers` field: a
 * status check must be safe to run from a lobby on a timer, and a credential
 * handed out on a timer is a credential handed out to whoever is watching.
 * The real ones come from POST /api/call/ice, once, at join.
 */
export interface RelayStatusReport {
  status: RelayStatus;
  /** How long a credential minted right now would last. 0 unless `ready`. */
  ttlSeconds: number;
  /**
   * Cloudflare's HTTP status, when it answered at all. This is the number
   * that tells `rejected` apart from `error` and it is safe to show: it says
   * nothing about the key beyond whether it was accepted.
   */
  httpStatus: number | null;
  /**
   * A short, secret-free sentence. Never contains the token, the key id, or
   * any part of a minted credential — see the fence in tests/call-relay-status.
   */
  detail: string | null;
}

/** Tone for the lobby indicator. `ok` is green, `warn` amber, `bad` red. */
export type RelayTone = "ok" | "warn" | "bad";

/**
 * The line the lobby shows, and the meaning under it.
 *
 * Bilingual on one line, for the reason every other status on this screen is
 * (see lib/call/session.ts): the two people on a call read different
 * languages and are looking at their own phones. `hint` is the sentence that
 * says what to DO — the missing half of PR #52's `relay: false`, which told a
 * founder something was wrong and nothing about which thing.
 */
export interface RelayCopy {
  label: string;
  hint: string;
  tone: RelayTone;
}

export function relayCopy(status: RelayStatus | null): RelayCopy {
  switch (status) {
    case "ready":
      return {
        label: "Relay: ✓ listo · ready",
        hint: "Cloudflare minted a credential. A call can fall back to the relay if the two phones cannot reach each other directly.",
        tone: "ok"
      };
    case "not_configured":
      return {
        label: "Relay: — sin configurar · not configured",
        hint: "No Cloudflare TURN keys on the server. Calls still connect wherever a direct path exists — two phones on cellular probably will not.",
        tone: "warn"
      };
    case "rejected":
      return {
        label: "Relay: ✗ rechazado · keys rejected",
        hint: "Cloudflare refused the credentials — revisar Cloudflare TURN keys in Vercel (CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN).",
        tone: "bad"
      };
    case "error":
      return {
        label: "Relay: ? sin respuesta · no answer",
        hint: "Cloudflare did not answer. Nothing is wrong with the keys — try again in a moment.",
        tone: "bad"
      };
    default:
      return {
        label: "Relay: comprobando… · checking…",
        hint: "",
        tone: "warn"
      };
  }
}

/**
 * Keep only the fields WebRTC reads, and only if they are the right shape.
 *
 * WebRTC throws on a malformed ICE server and takes the whole peer connection
 * with it, so a surprise in a provider's response must never reach a
 * constructor. Shared by the mint and the browser because both of them hold a
 * list that came off the wire.
 */
export function sanitizeIceServers(raw: unknown): RTCIceServerPayload[] {
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

/** Does this list actually contain a relay, rather than merely STUN? */
export function hasRelayServer(servers: RTCIceServerPayload[]): boolean {
  return servers.some((s) => s.urls.some((u) => u.startsWith("turn")));
}
