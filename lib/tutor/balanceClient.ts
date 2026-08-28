"use client";

// The browser's view of the meter.
//
// One fetch, one shape, one place that knows `-1` means unlimited — so the
// header chip, the out-of-minutes card and the end-of-session notice all read
// the same number, and that number is the one POST /api/tutor/realtime will
// actually enforce. The alternative (each surface summing `tutor_usage` for
// itself under RLS) is how a UI ends up offering a session the server refuses:
// the client cannot see another tab's open reservation, and it cannot see the
// founder bypass at all, because that is an email check in lib/release.ts
// rather than a column.

import { supabase } from "@/lib/supabase";

export interface TutorBalanceView {
  unlimited: boolean;
  tier: string;
  period: string;
  /** Seconds left. `Infinity` when unlimited — the -1 wire value is decoded here. */
  remainingSeconds: number;
  /** The month's plan allowance. `Infinity` when unlimited. */
  planSeconds: number;
  /** Plan seconds still unspent this month. `Infinity` when unlimited. */
  planLeft: number;
  /** Persistent pack balance, in seconds. Rolls over. */
  packSeconds: number;
  /** Enough left to be worth starting a session. */
  canStart: boolean;
}

/** JSON has no Infinity, so the wire uses -1. Exactly one place decodes it. */
function decode(n: unknown): number {
  if (typeof n !== "number") return 0;
  return n < 0 ? Infinity : n;
}

export function toBalanceView(payload: Record<string, unknown>): TutorBalanceView {
  const unlimited = payload.unlimited === true;
  const remainingSeconds = unlimited ? Infinity : decode(payload.remainingSeconds);
  return {
    unlimited,
    tier: typeof payload.tier === "string" ? payload.tier : "free",
    period: typeof payload.period === "string" ? payload.period : "",
    remainingSeconds,
    planSeconds: unlimited ? Infinity : decode(payload.planSeconds),
    planLeft: unlimited ? Infinity : decode(payload.planLeft),
    packSeconds: typeof payload.packSeconds === "number" ? payload.packSeconds : 0,
    canStart: payload.canStart === undefined ? remainingSeconds > 0 : payload.canStart === true
  };
}

/**
 * Read the balance.
 *
 * Returns null rather than throwing, and the callers treat null as "don't
 * know" rather than "zero": a chip that renders 0 min because a fetch was
 * interrupted would tell a paying customer they are out of minutes they have.
 * The mint is the fence; this is the display.
 */
export async function fetchTutorBalance(): Promise<TutorBalanceView | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    const res = await fetch("/api/tutor/balance", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store"
    });
    if (!res.ok) return null;
    return toBalanceView((await res.json()) as Record<string, unknown>);
  } catch {
    return null;
  }
}
