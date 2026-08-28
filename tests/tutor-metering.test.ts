// The cash register, pinned.
//
// Tutor phase 2 is the last gate before /tutor goes public, and it is the
// first tutor code that decides whether a customer gets what they paid for.
// So this file is about MONEY, not about plumbing: every test below is a
// sentence the pricing page makes, or a way a learner could be charged wrong.
//
// One thing it deliberately does NOT do is assert that a call was made.
// docs — and the tutor's own history — say why: for a month, Crawl showed "—"
// on every attempt because the route reached Azure, got a 200, and read the
// score off the wrong shape. A green round trip proved nothing. So the
// assertions here are on NUMBERS: seconds debited, seconds left, which balance
// they came out of.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  TUTOR_MIN_GRANT_SECONDS,
  TUTOR_PLAN_SECONDS,
  TUTOR_WARN_SECONDS,
  computeBalance,
  grantSeconds,
  sourceForPhase,
  splitDebit,
  tierFromProfile,
  tutorPeriod,
  wavSeconds
} from "@/lib/tutor/meter";
import { QUOTAS, type Tier } from "@/lib/supabase";
import {
  TURN_GRACE_SECONDS,
  WARN_LEAD_SECONDS,
  clockEventsBetween,
  newTurnGate,
  planSessionClock,
  requestEnd,
  turnEnded,
  turnStarted
} from "@/lib/tutor/sessionClock";
import { chipLabel, exhaustedBody, minutesLabel } from "@/lib/tutor/meterCopy";

const MIN = 60;

/** The default shape: nothing used, nothing bought, nothing held. */
function balance(over: Partial<Parameters<typeof computeBalance>[0]> = {}) {
  return computeBalance({
    tier: "free",
    packSeconds: 0,
    planUsed: 0,
    heldSeconds: 0,
    unlimited: false,
    ...over
  });
}

// ── The allowances the pricing page sells ───────────────────────────────────

describe("plan allowances", () => {
  it("are the numbers on the pricing page: 15 / 45 / 200", () => {
    expect(TUTOR_PLAN_SECONDS.free).toBe(15 * MIN);
    expect(TUTOR_PLAN_SECONDS.basic).toBe(45 * MIN);
    expect(TUTOR_PLAN_SECONDS.premium).toBe(200 * MIN);
    expect(TUTOR_PLAN_SECONDS.comp).toBe(Infinity);
  });

  it("matches QUOTAS, which is what the browser reads", () => {
    // The server cannot import lib/supabase.ts's client at runtime, so the
    // numbers exist twice. This is the fence that keeps the two copies equal —
    // a tier that says 45 in the UI and enforces 15 on the server is a support
    // email that looks exactly like a bug in the tutor.
    for (const tier of ["free", "basic", "premium", "comp"] as Tier[]) {
      expect(TUTOR_PLAN_SECONDS[tier], tier).toBe(QUOTAS[tier].tutorSeconds);
    }
  });

  it("is stated in the landing and paywall copy the customer actually reads", () => {
    const paywall = readFileSync(new URL("../components/Paywall.tsx", import.meta.url), "utf8");
    expect(paywall).toContain(`${TUTOR_PLAN_SECONDS.basic / MIN} tutor minutes`);
    expect(paywall).toContain(`${TUTOR_PLAN_SECONDS.premium / MIN} tutor minutes`);
  });
});

// ── The period ──────────────────────────────────────────────────────────────

describe("the billing period", () => {
  it("is the calendar month in UTC", () => {
    expect(tutorPeriod(new Date("2026-08-28T18:00:00Z"))).toBe("2026-08");
    expect(tutorPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
    expect(tutorPeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });

  it("rolls at the UTC boundary, not a local one", () => {
    // 2026-08-31 19:00 in Los Angeles is 2026-09-01 02:00 UTC. The month has
    // already turned. Documented rather than fudged: the alternative is a
    // reset date that moves when the learner gets on a plane, which is worse
    // for an app whose whole premise is travel.
    expect(tutorPeriod(new Date("2026-09-01T02:00:00Z"))).toBe("2026-09");
    expect(tutorPeriod(new Date("2026-08-31T23:59:59Z"))).toBe("2026-08");
  });
});

// ── The balance ─────────────────────────────────────────────────────────────

describe("what is left", () => {
  it("is the plan allowance on a fresh free account", () => {
    expect(balance().remainingSeconds).toBe(15 * MIN);
  });

  it("subtracts what has been used", () => {
    expect(balance({ planUsed: 10 * MIN }).remainingSeconds).toBe(5 * MIN);
  });

  it("adds the persistent pack balance on top", () => {
    const b = balance({ planUsed: 15 * MIN, packSeconds: 100 * MIN });
    expect(b.planLeft).toBe(0);
    expect(b.remainingSeconds).toBe(100 * MIN);
  });

  it("subtracts grants held by sessions that have not settled yet", () => {
    // Two tabs must not spend the same fifteen minutes. The open session's
    // FULL grant is held, not its elapsed time — the reservation is the fence.
    const b = balance({ heldSeconds: 10 * MIN });
    expect(b.remainingSeconds).toBe(5 * MIN);
  });

  it("never goes negative", () => {
    expect(balance({ planUsed: 999 * MIN }).remainingSeconds).toBe(0);
    expect(balance({ heldSeconds: 999 * MIN }).remainingSeconds).toBe(0);
  });

  it("is unlimited for comp and for founders", () => {
    expect(balance({ tier: "comp", unlimited: true }).remainingSeconds).toBe(Infinity);
    // A founder on the FREE tier is still unlimited: the bypass is the email,
    // not the plan (isFounder, lib/release.ts).
    const founder = balance({ tier: "free", unlimited: true, planUsed: 999 * MIN });
    expect(founder.remainingSeconds).toBe(Infinity);
    expect(founder.canStart).toBe(true);
  });
});

describe("month rollover", () => {
  it("resets plan minutes and keeps pack minutes", () => {
    // September: the ledger row for the new period does not exist yet, so
    // planUsed is 0 — while the pack balance is a column on profiles that no
    // month boundary touches. That asymmetry IS the product decision: plan
    // minutes are rented monthly, pack minutes are bought outright.
    const august = balance({ planUsed: 15 * MIN, packSeconds: 40 * MIN });
    expect(august.planLeft).toBe(0);
    expect(august.remainingSeconds).toBe(40 * MIN);

    const september = balance({ planUsed: 0, packSeconds: 40 * MIN });
    expect(september.planLeft).toBe(15 * MIN);
    expect(september.remainingSeconds).toBe(55 * MIN);
  });

  it("does not carry unused plan minutes forward", () => {
    // A free learner who used nothing in August starts September with 15, not
    // 30. Standard SaaS, and the copy says so (ROLLOVER_NOTE).
    expect(balance({ planUsed: 0 }).remainingSeconds).toBe(15 * MIN);
  });
});

// ── Ordering: plan first, then pack ─────────────────────────────────────────

describe("pack-then-plan ordering", () => {
  it("spends plan minutes before pack minutes", () => {
    // Spending the bought minutes while the rented ones sit unused would be
    // spending the customer's money before spending their subscription's.
    expect(splitDebit(60, 300, 6000)).toEqual({ plan: 60, pack: 0, unfunded: 0 });
  });

  it("spills into the pack only once the plan is exhausted", () => {
    expect(splitDebit(500, 300, 6000)).toEqual({ plan: 300, pack: 200, unfunded: 0 });
  });

  it("uses the pack alone when the plan is spent", () => {
    expect(splitDebit(120, 0, 6000)).toEqual({ plan: 0, pack: 120, unfunded: 0 });
  });

  it("reports the shortfall rather than inventing credit", () => {
    // A debit larger than everything available is capped at the grant upstream,
    // so this is narrow — but if it ever happens the ledger records the real
    // consumption and the balance simply cannot cover it. Silently shrinking
    // the number would make the cost reports lie.
    expect(splitDebit(500, 100, 100)).toEqual({ plan: 100, pack: 100, unfunded: 300 });
  });

  it("matches the SQL the database actually runs", () => {
    // splitDebit is a mirror of public.tutor_accrue. If they drift, the SQL is
    // what ran — so the migration is read here and the ordering is pinned in
    // both languages.
    const sql = readFileSync(
      new URL("../supabase/migrations/20260828_tutor_metering.sql", import.meta.url),
      "utf8"
    );
    expect(sql).toContain("v_plan_part := least(v_billed, greatest(v_plan_cap - v_plan_used, 0));");
    expect(sql).toContain("v_pack_part := v_billed - v_plan_part;");
    expect(sql).toContain("v_pack_part := least(v_pack_part, coalesce(v_pack_avail, 0));");
  });
});

// ── The grant ───────────────────────────────────────────────────────────────

describe("what a session is granted", () => {
  it("is what was asked for when there is plenty", () => {
    expect(grantSeconds(10 * MIN, balance({ tier: "premium" }))).toBe(10 * MIN);
  });

  it("is trimmed to what is left", () => {
    // A free learner with four minutes left gets a FOUR minute session, not a
    // ten-minute one that dies at four. The difference is whether being cut
    // off is something they were told or something they discovered.
    expect(grantSeconds(10 * MIN, balance({ planUsed: 11 * MIN }))).toBe(4 * MIN);
  });

  it("is refused when there is not enough left to be worth minting", () => {
    const nearlyOut = balance({ planUsed: 15 * MIN - (TUTOR_MIN_GRANT_SECONDS - 1) });
    expect(nearlyOut.canStart).toBe(false);
    expect(grantSeconds(10 * MIN, nearlyOut)).toBe(0);
  });

  it("is refused outright when the balance is spent", () => {
    expect(grantSeconds(10 * MIN, balance({ planUsed: 15 * MIN }))).toBe(0);
  });

  it("ignores the balance entirely for founders", () => {
    expect(grantSeconds(10 * MIN, balance({ unlimited: true, planUsed: 999 * MIN }))).toBe(10 * MIN);
  });

  it("never grants more than was asked for, however much is left", () => {
    // The client's cap is a CEILING the server may lower, never a floor it
    // must fill: a premium learner asking for a 10-minute Walk must not be
    // handed a 200-minute realtime session.
    expect(grantSeconds(5 * MIN, balance({ tier: "premium" }))).toBe(5 * MIN);
  });
});

// ── The tier ────────────────────────────────────────────────────────────────

describe("effective tier", () => {
  it("mirrors getTier(): canceled subscribers fall back to free, not locked out", () => {
    expect(tierFromProfile(null)).toBe("free");
    expect(tierFromProfile({ subscription_status: "canceled", tier: "premium" })).toBe("free");
    expect(tierFromProfile({ subscription_status: "active", tier: "premium" })).toBe("premium");
    expect(tierFromProfile({ subscription_status: "active", tier: null })).toBe("basic");
    expect(tierFromProfile({ subscription_status: "comp", tier: null })).toBe("comp");
  });
});

// ── Crawl's unit ────────────────────────────────────────────────────────────

describe("what Crawl is metered in", () => {
  it("is the duration of the audio assessed", () => {
    // 16 kHz mono 16-bit = 32000 bytes/second, plus the 44-byte WAV header.
    expect(wavSeconds(44 + 32_000 * 3)).toBe(3);
  });

  it("rounds up, so a partial second is never free", () => {
    expect(wavSeconds(44 + 16_000)).toBe(1);
  });

  it("is zero for a header with no audio behind it", () => {
    expect(wavSeconds(44)).toBe(0);
    expect(wavSeconds(0)).toBe(0);
  });

  it("costs a free learner a handful of seconds, not their month", () => {
    // Fifty repeat-after-me attempts at three seconds each is under three
    // minutes of a fifteen-minute allowance. Crawl is the phase that TEACHES;
    // pricing it like a conversation would be pricing the wrong thing.
    expect(wavSeconds(44 + 32_000 * 3) * 50).toBeLessThan(15 * MIN);
  });
});

describe("the ledger's source breakdown", () => {
  it("names every phase that spends", () => {
    expect(sourceForPhase("crawl")).toBe("crawl");
    expect(sourceForPhase("walk")).toBe("walk");
    expect(sourceForPhase("run")).toBe("run");
    expect(sourceForPhase("partner")).toBe("partner");
  });

  it("files anything unrecognised under partner rather than losing it", () => {
    // Conversation Partner posts no phase at all, and an unknown phase is
    // still a real minute. Dropping it would make the breakdown stop summing
    // to seconds_used, which is the one invariant the table has.
    expect(sourceForPhase(undefined)).toBe("partner");
    expect(sourceForPhase("something-new")).toBe("partner");
  });
});

// ── Warn, then end at a turn boundary ───────────────────────────────────────

describe("the warn-then-end sequence", () => {
  it("warns two minutes before the end", () => {
    const clock = planSessionClock(10 * MIN);
    expect(WARN_LEAD_SECONDS).toBe(TUTOR_WARN_SECONDS);
    expect(clock.warnAtSeconds).toBe(8 * MIN);
    expect(clock.endAtSeconds).toBe(10 * MIN);
  });

  it("does not warn at all on a session shorter than the lead", () => {
    // Telling someone with 90 seconds left that they have two minutes left is
    // worse than saying nothing. The header chip already showed the number.
    expect(planSessionClock(90).warnAtSeconds).toBeNull();
    expect(planSessionClock(WARN_LEAD_SECONDS).warnAtSeconds).toBeNull();
  });

  it("fires warn, then end, in that order", () => {
    const clock = planSessionClock(5 * MIN);
    expect(clockEventsBetween(179, 180, clock)).toEqual(["warn"]);
    expect(clockEventsBetween(299, 300, clock)).toEqual(["end"]);
    expect(clockEventsBetween(300, 301, clock)).toEqual([]);
  });

  it("fires each threshold exactly once", () => {
    const clock = planSessionClock(5 * MIN);
    let warns = 0;
    for (let t = 1; t <= 5 * MIN; t++) {
      if (clockEventsBetween(t - 1, t, clock).includes("warn")) warns++;
    }
    expect(warns).toBe(1);
  });

  it("still fires when the tab was asleep and the tick was late", () => {
    // iOS throttles a backgrounded tab's intervals to whenever it feels like
    // it. A warning that only fires on the exact second is a warning that does
    // not fire, so the check is a CROSSING between two ticks.
    const clock = planSessionClock(10 * MIN); // warns at 8:00, ends at 10:00
    expect(clockEventsBetween(60, 500, clock)).toEqual(["warn"]);
    expect(clockEventsBetween(60, 620, clock)).toEqual(["warn", "end"]);
    // A tab asleep past the grace window comes back to all three at once, and
    // the hard stop is the one that must survive: a session that slept through
    // its own cap is exactly the one still holding a live microphone.
    expect(clockEventsBetween(60, 900, clock)).toEqual(["warn", "end", "hard-stop"]);
  });

  it("has a hard stop after the turn grace", () => {
    const clock = planSessionClock(10 * MIN);
    expect(clock.hardStopAtSeconds).toBe(10 * MIN + TURN_GRACE_SECONDS);
  });
});

describe("ending at a turn boundary", () => {
  it("stops immediately when nobody is talking", () => {
    const { stopNow } = requestEnd(newTurnGate());
    expect(stopNow).toBe(true);
  });

  it("waits for the tutor to finish its sentence", () => {
    // The whole point: no hard cutoff mid-sentence.
    let gate = turnStarted(newTurnGate());
    const asked = requestEnd(gate);
    expect(asked.stopNow).toBe(false);
    gate = asked.gate;

    const landed = turnEnded(gate);
    expect(landed.stopNow).toBe(true);
  });

  it("does not stop on a turn boundary nobody asked about", () => {
    const gate = turnStarted(newTurnGate());
    expect(turnEnded(gate).stopNow).toBe(false);
  });

  it("does not wait forever: the clock's hard stop is independent of the gate", () => {
    // A turn that never lands — a stalled response, a dead data channel — must
    // not hold a paid session and a live microphone open. The gate is a
    // courtesy; the hard stop is the guarantee.
    const clock = planSessionClock(60);
    let gate = turnStarted(newTurnGate());
    gate = requestEnd(gate).gate;
    expect(gate.pending).toBe(true);
    expect(clockEventsBetween(60, 91, clock)).toContain("hard-stop");
  });
});

// ── The copy ────────────────────────────────────────────────────────────────

describe("what the learner is told", () => {
  it("rounds minutes DOWN, so the chip never over-promises", () => {
    expect(minutesLabel(3 * MIN + 59).en).toBe("3 min");
  });

  it("distinguishes nearly-out from out", () => {
    // "Under a minute" is a warning; "None left" is a wall. Printing both as
    // "0 min" would collapse the difference at exactly the wrong moment.
    expect(minutesLabel(59).en).toBe("Under a minute");
    expect(minutesLabel(0).en).toBe("None left");
  });

  it("is bilingual", () => {
    expect(minutesLabel(59).es).toBe("Menos de un minuto");
    // "Unlimited", not "Founder": a comped account is unlimited too, and
    // calling it a founder would be a small lie shown on every screen.
    expect(chipLabel(Infinity, true)).toBe("Unlimited · sin límite");
    expect(chipLabel(12 * MIN, false)).toContain("restantes");
  });

  it("offers a subscriber packs, not the plan they already bought", () => {
    // Selling somebody the subscription they are already paying for is the
    // moment people cancel.
    expect(exhaustedBody("basic", 0).en).toContain("pack");
    expect(exhaustedBody("free", 0).en).toContain("15 tutor minutes");
    expect(exhaustedBody("free", 0).en).not.toContain("pack");
  });

  it("says pack minutes roll over, wherever it mentions them", () => {
    expect(exhaustedBody("basic", 0).en).toContain("rolls over");
    expect(exhaustedBody("basic", 0).es).toContain("acumula");
    expect(exhaustedBody("premium", 30).en).toContain("roll over");
  });
});

// ── Server authority ────────────────────────────────────────────────────────

describe("the browser cannot write its own usage", () => {
  it("has no client-side tutor_sessions insert or update left", () => {
    // The RLS policies are gone (20260828_tutor_metering.sql), so these calls
    // could not work any more — but code that tries and silently fails is
    // worse than code that is not there.
    const supabaseLib = readFileSync(new URL("../lib/supabase.ts", import.meta.url), "utf8");
    expect(supabaseLib).not.toContain('from("tutor_sessions")');
    expect(supabaseLib).not.toMatch(/export (async )?function (start|end)TutorSession/);
  });

  it("drops the RLS policies that let it", () => {
    const sql = readFileSync(
      new URL("../supabase/migrations/20260828_tutor_metering.sql", import.meta.url),
      "utf8"
    );
    expect(sql).toContain("drop policy if exists tutor_sessions_insert_own");
    expect(sql).toContain("drop policy if exists tutor_sessions_update_own");
    // Select and delete stay: history is theirs to read, and
    // delete-means-delete (PR #37) needs the delete policy.
    expect(sql).toContain("create policy tutor_sessions_select_own");
    expect(sql).toContain("create policy tutor_sessions_delete_own");
  });

  it("gives tutor_usage no write policy at all", () => {
    // A quota the metered party can write is not a quota.
    const sql = readFileSync(
      new URL("../supabase/migrations/20260828_tutor_metering.sql", import.meta.url),
      "utf8"
    );
    expect(sql).toContain("create policy tutor_usage_own_select");
    expect(sql).not.toMatch(/create policy tutor_usage\w*\s+on public\.tutor_usage\s+for (insert|update|delete)/);
  });

  it("drops the dead tutor_mastery table rather than leaving the trap", () => {
    // Zero rows, zero call sites, and a CHECK pinning course_id to two courses
    // that no longer exist — so every real module id would be REJECTED. It
    // looked like a head start on server-side progress and was the opposite.
    const sql = readFileSync(
      new URL("../supabase/migrations/20260828_tutor_metering.sql", import.meta.url),
      "utf8"
    );
    expect(sql).toContain("drop table if exists public.tutor_mastery");
  });
});

describe("metering cannot be skipped in production", () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ENV };
    vi.resetModules();
  });

  it("refuses rather than minting an unmetered session without the service key", async () => {
    // SUPABASE_SERVICE_ROLE_KEY is marked sensitive in Vercel, so a laptop
    // never has one — which is fine locally and catastrophic in production,
    // where a missing key would silently turn the cash register into an open
    // door on the exact deploy that opened the tutor to customers.
    process.env.VERCEL_ENV = "production";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { readTutorBalance, TutorMeterUnavailableError } = await import("@/lib/tutor/meter");
    await expect(readTutorBalance({ id: "u1", email: "a@b.c" })).rejects.toBeInstanceOf(
      TutorMeterUnavailableError
    );
  });

  it("stays open, loudly, off production", async () => {
    process.env.VERCEL_ENV = "preview";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { readTutorBalance } = await import("@/lib/tutor/meter");
    const b = await readTutorBalance({ id: "u1", email: "a@b.c" });
    expect(b.unlimited).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("meter_unavailable");
    warn.mockRestore();
  });
});
