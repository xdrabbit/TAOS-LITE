// The server-side cap on /fast.
//
// The client debounces at 300ms (lib/fast/settle.ts) and that is the control
// that matters in normal use — but a debounce is a courtesy the browser
// extends, and the route is what the bill is drawn against. A held-down key,
// a stuck retry loop, or somebody driving the endpoint directly all bypass it
// entirely, and this screen's shape (one request per typing pause) means the
// per-user rate here is legitimately much higher than any other route's, so
// "it looks busy" is not a signal anything can act on. Hence a hard ceiling.
//
// Reuses the fixed-window counter from lib/spendGuard.ts rather than growing a
// second one — including its two honest limits: the window is PER INSTANCE and
// it resets on a cold start. Fluid Compute reuses instances, so a burst from
// one person lands mostly on one of them; with several warm instances the
// effective ceiling is this number times the instance count.
//
// ── This is the fast path, not the ceiling (8/31) ──────────────────────────
// Which is why it stopped being the only counter. The DURABLE limit lives in
// Postgres now, on the same two windows and off the same environment
// variables (lib/fast/meter.ts, public.fast_begin): shared by every instance,
// surviving a cold start, and therefore the number that actually holds.
//
// This one stays because it is FREE and it runs FIRST — before the body is
// read, before a round trip is spent. A held key or a stuck retry loop is
// refused here at no cost at all, and only traffic that looks like typing
// ever reaches the database. Neither is an anti-abuse fence; the fence is
// guardSpend's session check, which runs before both and means every hit
// counted anywhere belongs to a known account.
import { hit } from "@/lib/spendGuard";

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Requests per user per minute.
 *
 * 60 is deliberately generous against real typing: at a 300ms debounce, a
 * person typing a phrase and pausing to think produces on the order of five
 * to ten requests a sentence, so a minute of continuous work sits well under
 * this. It is tight against a runaway: 60 quickies is $0.016 of Azure or
 * $0.0016 of gpt-4.1-nano (docs/fast-engine.md), so a stuck loop costs cents
 * an hour rather than dollars.
 */
const FAST_PER_MINUTE = numberFromEnv("TAOS_FAST_RATE_PER_MINUTE", 60);

/** Per user per hour — the bound on a loop nobody notices until morning. */
const FAST_PER_HOUR = numberFromEnv("TAOS_FAST_RATE_PER_HOUR", 600);

const minuteBuckets = new Map<string, { count: number; resetAt: number }>();
const hourBuckets = new Map<string, { count: number; resetAt: number }>();

/** Drop every counter. Tests only — a fresh instance is the production reset. */
export function resetFastRateLimits(): void {
  minuteBuckets.clear();
  hourBuckets.clear();
}

export interface FastRateVerdict {
  allowed: boolean;
  /** Which window tripped, for the message and for the log. */
  window: "minute" | "hour" | null;
}

/**
 * Count one request for this user and say whether it fits.
 *
 * Short-circuits on the first window that trips, for the same reason
 * guardSpend does: burning the hour's budget on requests the minute window
 * already refused would turn a fast typist into an hour-long lockout.
 */
export function checkFastRate(userId: string, now = Date.now()): FastRateVerdict {
  if (!hit(minuteBuckets, userId, FAST_PER_MINUTE, 60_000, now)) {
    return { allowed: false, window: "minute" };
  }
  if (!hit(hourBuckets, userId, FAST_PER_HOUR, 3_600_000, now)) {
    return { allowed: false, window: "hour" };
  }
  return { allowed: true, window: null };
}
