// Who is allowed to spend money.
//
// The bug this exists for (ship report cdf9f02a, 8/19): POST /api/tts on
// production answered a bare curl with 14KB of ElevenLabs audio. No session,
// no cookie, no header — just a public URL that bills Tom's card per call.
// /api/translate (Whisper + a chat model) was the same, and so was every
// realtime MINTING route, which is worse: a minted client secret is a live
// OpenAI Realtime session that keeps billing after the request that made it
// has returned.
//
// So: a route that spends money now asks this module first, and the refusal
// happens BEFORE the provider is called. Not after, not alongside — the
// 401 must cost nothing, or the fence is just a slower way to pay.
//
// ── The one exception ──────────────────────────────────────────────────────
// /try is the "Try it now, no signup" funnel on the landing page
// (components/AtomShell.tsx), and it is SUPPOSED to work without an account.
// Requiring auth there would close the front door to sell the house. Those
// two routes — /api/tts and /api/translate — therefore take a second path:
// `allowAnonymous`, which is an origin check plus a tight per-IP rate limit
// plus a cap on what an anonymous caller may ask for.
//
// Be honest about what that second path is worth: an Origin header is
// client-supplied and a determined attacker forges it, and the rate limit is
// per-instance (see below). It stops the bare curl in the ship report and it
// bounds a script to a trickle; it is not a substitute for auth. That is why
// the anonymous path is allowed to reach only the CHEAP engine — OpenAI TTS
// and one transcription — while ElevenLabs, the clones, and every realtime
// session stay behind a real session with no exception at all.

import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { getUserFromRequest } from "./authServer";
import { isAllowedAuthOrigin } from "./authRedirect";

/** Shown to a signed-out caller on a route that has no anonymous path. */
export const SIGN_IN_REQUIRED = "Please sign in to use this feature.";

/** Shown when the anonymous /try allowance is spent. */
export const TRY_LIMIT_REACHED =
  "The free trial limit was reached. Please sign in to keep going.";

/**
 * A guard's answer: who is calling, or the response to return instead.
 *
 * `user` is null only on an allowed ANONYMOUS call — a route that did not pass
 * `allowAnonymous` never sees it, so `ok: true` there means a real session.
 */
export type GuardResult =
  | { ok: true; user: User | null; anonymous: boolean }
  | { ok: false; response: NextResponse };

function deny(message: string, status: number): { ok: false; response: NextResponse } {
  return {
    ok: false,
    response: NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } })
  };
}

// ── Rate limiting ───────────────────────────────────────────────────────────
// A fixed-window counter held in module scope. Two honest caveats, because a
// rate limit nobody understands the limits of is worse than none:
//
//   1. It is PER INSTANCE. Vercel Fluid Compute reuses instances, so in
//      practice a burst from one IP lands mostly on one of them — but with
//      several warm instances the effective ceiling is the limit times the
//      instance count. Bounding that is what ANON_GLOBAL_PER_HOUR is for.
//   2. It resets on a cold start.
//
// A durable counter (Supabase, Upstash) would fix both and costs a round trip
// on the hot path of every translation. That trade is worth revisiting if the
// funnel ever gets abused for real; for a front door that exists to be walked
// through a few times, this is the right size.

/** Per-IP: short burst window. A /try turn is ~2 calls (translate + hear). */
const ANON_PER_MINUTE = numberFromEnv("TAOS_ANON_RATE_PER_MINUTE", 10);
/** Per-IP: the actual size of a "try before you buy". */
const ANON_PER_HOUR = numberFromEnv("TAOS_ANON_RATE_PER_HOUR", 60);
/** Every anonymous caller this instance has, together. The blast-radius cap. */
const ANON_GLOBAL_PER_HOUR = numberFromEnv("TAOS_ANON_GLOBAL_PER_HOUR", 400);

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

interface Window {
  count: number;
  resetAt: number;
}

const minuteBuckets = new Map<string, Window>();
const hourBuckets = new Map<string, Window>();

/**
 * Count one hit and say whether it fits under `limit`.
 *
 * Exported for the tests, which need to drive the windows directly rather than
 * wait a real minute out.
 */
export function hit(
  buckets: Map<string, Window>,
  key: string,
  limit: number,
  windowMs: number,
  now: number
): boolean {
  const existing = buckets.get(key);
  if (!existing || now >= existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    // Opportunistic sweep: without it a long-lived instance accumulates a
    // bucket per IP forever. Cheap because it only runs on a window rollover.
    if (buckets.size > 5000) {
      for (const [k, w] of buckets) if (now >= w.resetAt) buckets.delete(k);
    }
    return true;
  }
  existing.count += 1;
  return existing.count <= limit;
}

/** Drop every counter. Tests only — a fresh instance is the production reset. */
export function resetRateLimits(): void {
  minuteBuckets.clear();
  hourBuckets.clear();
}

/**
 * The caller's IP, as Vercel reports it.
 *
 * `x-forwarded-for` is a comma-separated chain and the FIRST entry is the
 * client; the rest are proxies. On Vercel the header is set by the platform,
 * so the first entry is trustworthy here — behind some other proxy it would
 * not be, which is one more reason the anonymous path is capped globally too.
 */
export function callerIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Did this request come from our own app in a browser?
 *
 * `Origin` is what a same-origin POST from the page sends and is the value we
 * want. `Referer` is the fallback for the browsers and privacy modes that
 * trim Origin on same-origin requests; only its origin is read, never its
 * path. A request carrying NEITHER is not a browser on our site — that is the
 * bare curl from the ship report, and it is the case this rejects.
 *
 * The allow-list is `isAllowedAuthOrigin` (lib/authRedirect.ts) rather than a
 * second list of hosts, deliberately: previews and localhost have to keep
 * working, and two allow-lists drift apart the first time one gains a host.
 */
export function fromTrustedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) return isAllowedAuthOrigin(origin);

  const referer = req.headers.get("referer");
  if (!referer) return false;
  try {
    return isAllowedAuthOrigin(new URL(referer).origin);
  } catch {
    return false;
  }
}

export interface GuardOptions {
  /**
   * Let the /try funnel through without a session, under the origin check and
   * the rate limits above. Only /api/tts and /api/translate pass this, and
   * each narrows what an anonymous caller may ask for on top (cheap engine,
   * bounded input) — see their own comments.
   */
  allowAnonymous?: boolean;
  /** Injected by the tests so windows can be driven without waiting. */
  now?: number;
}

/**
 * The gate every money-spending route calls first.
 *
 * A valid Supabase access token in `Authorization: Bearer …` is the normal
 * way through, and it is checked FIRST so a signed-in person is never rate
 * limited by somebody else sharing their NAT.
 */
export async function guardSpend(req: Request, options: GuardOptions = {}): Promise<GuardResult> {
  const { allowAnonymous = false, now = Date.now() } = options;

  const user = await getUserFromRequest(req);
  if (user) return { ok: true, user, anonymous: false };

  if (!allowAnonymous) return deny(SIGN_IN_REQUIRED, 401);

  // From here down the caller is anonymous and the route has opted into the
  // /try funnel.
  if (!fromTrustedOrigin(req)) return deny(SIGN_IN_REQUIRED, 401);

  // Short-circuit on the FIRST limit that trips, rather than counting a hit in
  // all three. One IP hammering the minute window must not also drain the
  // shared hourly bucket — that would let a single script lock every other
  // anonymous visitor out of the funnel, which is the outage the cap exists to
  // prevent rather than cause.
  const ip = callerIp(req);
  if (!hit(minuteBuckets, `ip:${ip}`, ANON_PER_MINUTE, 60_000, now)) {
    return deny(TRY_LIMIT_REACHED, 429);
  }
  if (!hit(hourBuckets, `ip:${ip}`, ANON_PER_HOUR, 3_600_000, now)) {
    return deny(TRY_LIMIT_REACHED, 429);
  }
  if (!hit(hourBuckets, "global", ANON_GLOBAL_PER_HOUR, 3_600_000, now)) {
    return deny(TRY_LIMIT_REACHED, 429);
  }

  return { ok: true, user: null, anonymous: true };
}
