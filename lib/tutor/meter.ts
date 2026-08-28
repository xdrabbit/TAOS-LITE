// The cash register.
//
// Phase 1 left this file as a SEAM: two functions that wrote a structured line
// to the Vercel runtime log when a tutor session started and ended, plus a
// promise about what phase 2 would put in them —
//
//   start — refuse when the month's minutes are spent, and reserve.
//   end   — debit, and write the row the balance is computed from.
//
// This is that. The seam held: `beginTutorSession` and `settleTutorSession`
// below are still the only two moments in the app that a tutor minute is
// created or spent, and the allowance rule that used to live inline in
// app/api/tutor/realtime now lives here — so Walk, Run, Partner and Crawl ask
// one question instead of growing four answers to it.
//
// ── What is metered, and how it is measured ────────────────────────────────
//
// Four sources, all of them real spend:
//
//   walk / run / partner — a realtime session. Measured by the SERVER's clock
//     from mint to settle, capped at the grant. Never by the number the
//     browser reports about its own usage: that is the party with an interest
//     in it being small, and phase 1's end route already refused to trust it.
//     The client's figure is still recorded (tutor_sessions.client_seconds)
//     because drift between the two is the first sign something is wrong.
//
//   crawl — Azure pronunciation scoring. There is no session to time, so the
//     unit is the DURATION OF THE AUDIO ASSESSED, which is both the thing
//     Azure bills for and a number the server can measure for itself off the
//     WAV it was handed. A repeat-after-me attempt is a few seconds; a free
//     learner will not lose their month to drills, which is the right answer
//     for the phase that teaches.
//
// ── Reservation, not trust ─────────────────────────────────────────────────
//
// A grant is HELD in full from the moment a session is minted until it
// settles. So two tabs cannot spend the same fifteen minutes twice, and a
// session whose end beacon never arrives — airplane mode, a killed app, a
// crashed tab — does not become free minutes: it is collected by
// `tutor_reap_open_sessions` at its full grant on the owner's next check.
// The pessimistic answer is the honest one, because OpenAI billed for the
// whole thing whether or not the browser lived long enough to say so.
//
// ── Founders ───────────────────────────────────────────────────────────────
//
// isFounder() (lib/release.ts) bypasses metering entirely: unlimited grant, no
// ledger entry, no balance to run out of. The session row is still written
// with `metered = false`, so the minutes remain visible to a cost query — Tom
// and Liz testing the tutor every day is a real OpenAI bill and pretending
// otherwise would make the cost reports lie.

import type { Tier } from "@/lib/supabase";
import { isFounder } from "@/lib/release";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";

export type TutorSessionEndReason = "user" | "cap" | "idle" | "error" | "unknown";

export interface TutorSessionStartEvent {
  event: "start";
  sessionId: string;
  /** Supabase user id, or null on a path that allowed an anonymous caller. */
  userId: string | null;
  phase: string;
  moduleId?: string | null;
  target: string;
  learner: string;
  level: string;
  /** The realtime model actually minted — the line item on the OpenAI bill. */
  model?: string;
  /** The hard cap this session was minted under, in seconds. */
  capSeconds?: number;
  /** What the meter actually reserved: min(cap, remaining balance). */
  grantedSeconds?: number;
  /** Balance left AFTER this reservation, or -1 for founders/comp. */
  remainingSeconds?: number;
  /** True when this session is not charged against anything (founder). */
  unmetered?: boolean;
}

export interface TutorSessionEndEvent {
  event: "end";
  sessionId: string;
  userId: string | null;
  /** Elapsed seconds, from the SERVER's clock. This is what was debited. */
  seconds: number;
  reason: TutorSessionEndReason | "lost";
  phase?: string;
  moduleId?: string | null;
  /** What the browser claimed. Kept beside `seconds` to make drift greppable. */
  clientSeconds?: number | null;
  unmetered?: boolean;
}

export type TutorSessionEvent = TutorSessionStartEvent | TutorSessionEndEvent;

/** The one log prefix. Change it here and every dashboard query follows. */
export const TUTOR_SESSION_LOG = "taos.tutor.session";

/**
 * Emit a session event.
 *
 * Never throws: a metering line is not worth failing a lesson over, and the
 * fact that it cannot fail is precisely why the actual debit below is NOT in a
 * `catch {}` next to it.
 */
export function logTutorSessionEvent(event: TutorSessionEvent): void {
  try {
    // eslint-disable-next-line no-console
    console.log(`${TUTOR_SESSION_LOG} ${JSON.stringify(event)}`);
  } catch {
    /* ignore */
  }
}

/** An id that ties a start line to its end line in the log. */
export function newTutorSessionId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `ts_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

// ── The numbers ─────────────────────────────────────────────────────────────

/**
 * The monthly plan allowance, in seconds, per tier.
 *
 * These are the numbers on the pricing page (components/Paywall.tsx and the
 * landing copy) and in `QUOTAS` in lib/supabase.ts, which is what the browser
 * reads. Restated here rather than imported because lib/supabase.ts builds a
 * BROWSER Supabase client at module scope and this file runs on the server —
 * tests/tutor-metering.test.ts pins the two lists together so they cannot
 * drift, which is the only reason a second copy is safe.
 *
 * `comp` is unlimited: it is the hand-comped account, not a plan anyone buys.
 */
export const TUTOR_PLAN_SECONDS: Record<Tier, number> = {
  free: 15 * 60,
  basic: 45 * 60,
  premium: 200 * 60,
  comp: Infinity
};

/**
 * How long before the end of a session the learner is warned.
 *
 * Two minutes, because the thing being interrupted is a CONVERSATION in a
 * language the learner is bad at. Enough to finish a thought and say goodbye;
 * not so much that the warning is the session.
 */
export const TUTOR_WARN_SECONDS = 120;

/**
 * The smallest session worth minting.
 *
 * Below this the honest answer is "not enough left", not a forty-second
 * conversation that ends mid-greeting and still costs a mint. The stranded
 * remainder stays on the ledger and is spendable on Crawl, which has no floor.
 */
export const TUTOR_MIN_GRANT_SECONDS = 30;

/** Where a metered second came from. Mirrors tutor_usage's breakdown columns. */
export type TutorSource = "crawl" | "walk" | "run" | "partner";

/** The tutor phase → the ledger column it accrues to. */
export function sourceForPhase(phase: string | null | undefined): TutorSource {
  switch (phase) {
    case "crawl":
      return "crawl";
    case "walk":
      return "walk";
    case "run":
      return "run";
    default:
      return "partner";
  }
}

/**
 * The billing period: the calendar month, in UTC, as `YYYY-MM`.
 *
 * NOT the Stripe billing anniversary — the free tier has no subscription and
 * therefore no anniversary, and every other quota in this app already resets
 * on the calendar month (`getMonthlyUsage` in lib/supabase.ts). Two different
 * reset dates would be two things to explain on the pricing page.
 *
 * UTC because the server has no opinion about where the learner is standing,
 * and a month boundary that moves with a plane is worse than one that arrives
 * an hour early in California.
 */
export function tutorPeriod(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** What the ledger and the profile say about one learner, one month. */
export interface TutorBalanceInput {
  tier: Tier;
  /** Persistent add-on pack balance, in seconds. Rolls over; never resets. */
  packSeconds: number;
  /** Seconds already settled against the plan this period. */
  planUsed: number;
  /** Grants currently held by unsettled sessions. */
  heldSeconds: number;
  /** Founder, or a comped account: metering does not apply. */
  unlimited: boolean;
}

export interface TutorBalance {
  tier: Tier;
  period: string;
  unlimited: boolean;
  /** The month's plan allowance. Infinity when unlimited. */
  planSeconds: number;
  /** Plan seconds spent this month. */
  planUsed: number;
  /** Plan seconds still available this month. */
  planLeft: number;
  /** The persistent pack balance. */
  packSeconds: number;
  /** Reserved by sessions that have not settled yet. */
  heldSeconds: number;
  /** planLeft + packSeconds − heldSeconds, floored at 0. Infinity if unlimited. */
  remainingSeconds: number;
  /** False when there is not enough left to be worth minting a session. */
  canStart: boolean;
}

/**
 * The whole allowance rule, as arithmetic.
 *
 * Plan minutes are spent FIRST and packs second — a pack is a purchase that
 * rolls over, so burning it while a monthly allowance sits unused would be
 * spending the customer's money before spending their subscription's.
 */
export function computeBalance(input: TutorBalanceInput, period = tutorPeriod()): TutorBalance {
  const planSeconds = input.unlimited ? Infinity : TUTOR_PLAN_SECONDS[input.tier];
  const planUsed = Math.max(0, input.planUsed);
  const packSeconds = Math.max(0, input.packSeconds);
  const heldSeconds = Math.max(0, input.heldSeconds);

  if (!Number.isFinite(planSeconds)) {
    return {
      tier: input.tier,
      period,
      unlimited: true,
      planSeconds: Infinity,
      planUsed,
      planLeft: Infinity,
      packSeconds,
      heldSeconds,
      remainingSeconds: Infinity,
      canStart: true
    };
  }

  const planLeft = Math.max(0, planSeconds - planUsed);
  const remainingSeconds = Math.max(0, planLeft + packSeconds - heldSeconds);
  return {
    tier: input.tier,
    period,
    unlimited: false,
    planSeconds,
    planUsed,
    planLeft,
    packSeconds,
    heldSeconds,
    remainingSeconds,
    canStart: remainingSeconds >= TUTOR_MIN_GRANT_SECONDS
  };
}

/**
 * What a session asking for `requestedSeconds` actually gets.
 *
 * Zero means refuse — the caller turns that into the 402 and the paywall.
 */
export function grantSeconds(requestedSeconds: number, balance: TutorBalance): number {
  const wanted = Math.max(0, Math.round(requestedSeconds));
  if (wanted <= 0) return 0;
  if (balance.unlimited) return wanted;
  if (!balance.canStart) return 0;
  return Math.min(wanted, balance.remainingSeconds);
}

/**
 * How `seconds` is split between the plan and the pack.
 *
 * A mirror of what `public.tutor_accrue` does in SQL, exported so
 * tests/tutor-metering.test.ts can pin the ordering rule in the language the
 * pricing page is written in rather than only inside a plpgsql function no
 * test can reach. If these two ever disagree, the SQL is the one that ran.
 */
export function splitDebit(
  seconds: number,
  planLeft: number,
  packSeconds: number
): { plan: number; pack: number; unfunded: number } {
  const total = Math.max(0, Math.round(seconds));
  const plan = Math.min(total, Math.max(0, planLeft));
  const pack = Math.min(total - plan, Math.max(0, packSeconds));
  return { plan, pack, unfunded: total - plan - pack };
}

/**
 * Seconds of 16 kHz mono 16-bit PCM in a WAV of this many bytes.
 *
 * The unit Crawl is metered in. Read off the byte count rather than decoded,
 * because lib/tutor/wav.ts produces exactly this format for exactly this
 * endpoint (app/api/tutor/assess) and the 44-byte header is the only thing
 * standing between length and duration. Rounded UP so a two-second attempt is
 * never billed as one.
 */
export function wavSeconds(byteLength: number, sampleRate = 16_000): number {
  const bytesPerSecond = sampleRate * 2; // mono, 16-bit
  const audioBytes = Math.max(0, byteLength - 44);
  return Math.ceil(audioBytes / bytesPerSecond);
}

// ── The server lifecycle ────────────────────────────────────────────────────

/**
 * Whether the meter can actually meter.
 *
 * Every read and write below goes through the service role, and
 * `SUPABASE_SERVICE_ROLE_KEY` is marked sensitive in Vercel — `vercel env
 * pull` returns an empty string for it, so a laptop never has one. That is
 * fine for local work and NOT fine in production: a missing key there would
 * turn the whole cash register into an open door, silently, on the exact
 * deploy that opened the tutor to customers.
 *
 * So: unmetered-with-a-loud-log off production, hard refusal on it.
 */
function meteringAvailable(): boolean {
  return hasServiceRoleKey;
}

function inProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
}

/** Raised when production is missing the key the meter cannot work without. */
export class TutorMeterUnavailableError extends Error {
  constructor() {
    super(
      "Tutor metering is unavailable: SUPABASE_SERVICE_ROLE_KEY is not set. " +
        "Refusing to mint an unmetered session in production."
    );
    this.name = "TutorMeterUnavailableError";
  }
}

/** The effective tier for a profile row, mirroring getTier() in lib/supabase. */
export function tierFromProfile(
  profile: { subscription_status?: string | null; tier?: string | null } | null
): Tier {
  if (!profile) return "free";
  if (profile.subscription_status === "comp") return "comp";
  if (profile.subscription_status === "active") {
    return profile.tier === "premium" ? "premium" : "basic";
  }
  return "free";
}

export interface TutorUser {
  id: string;
  email?: string | null;
}

/**
 * Read one learner's balance for the current period.
 *
 * Reaps their abandoned sessions first — that is the only place the reaper is
 * called from, and it is per-user rather than a cron because the only person
 * a stale hold hurts is its owner, and the moment it hurts them is the moment
 * they come back and ask.
 */
export async function readTutorBalance(user: TutorUser): Promise<TutorBalance> {
  const period = tutorPeriod();
  const unlimitedByEmail = isFounder(user.email);

  if (!meteringAvailable()) {
    if (inProduction()) throw new TutorMeterUnavailableError();
    // Local and preview without the sensitive key: everything is unlimited,
    // and says so, so nobody reads a green screen as a working meter.
    // eslint-disable-next-line no-console
    console.warn(`${TUTOR_SESSION_LOG} meter_unavailable · no service-role key · unmetered`);
    return computeBalance(
      { tier: "comp", packSeconds: 0, planUsed: 0, heldSeconds: 0, unlimited: true },
      period
    );
  }

  await supabaseAdmin.rpc("tutor_reap_open_sessions", { p_user_id: user.id }).then(
    () => undefined,
    () => undefined // best effort: a failed reap over-counts, it never under-counts
  );

  const [{ data: profile }, { data: usage }, { data: open }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("subscription_status, tier, pack_seconds")
      .eq("id", user.id)
      .maybeSingle(),
    supabaseAdmin
      .from("tutor_usage")
      .select("seconds_used, pack_seconds_used")
      .eq("user_id", user.id)
      .eq("period", period)
      .maybeSingle(),
    supabaseAdmin
      .from("tutor_sessions")
      .select("granted_seconds")
      .eq("user_id", user.id)
      .is("settled_at", null)
  ]);

  const tier = tierFromProfile(profile as { subscription_status?: string; tier?: string } | null);
  const secondsUsed = (usage as { seconds_used?: number } | null)?.seconds_used ?? 0;
  const packUsed = (usage as { pack_seconds_used?: number } | null)?.pack_seconds_used ?? 0;
  const heldSeconds = ((open ?? []) as Array<{ granted_seconds?: number | null }>).reduce(
    (a, r) => a + (typeof r.granted_seconds === "number" ? r.granted_seconds : 0),
    0
  );

  return computeBalance(
    {
      tier,
      // Only the plan half of what has been used counts against the plan
      // allowance; the pack half already came off the pack balance.
      planUsed: Math.max(0, secondsUsed - packUsed),
      packSeconds: (profile as { pack_seconds?: number } | null)?.pack_seconds ?? 0,
      heldSeconds,
      unlimited: unlimitedByEmail || tier === "comp"
    },
    period
  );
}

export interface BeginTutorSessionInput {
  user: TutorUser;
  /** walk | run | partner for realtime; crawl for a scored attempt. */
  phase: string;
  /** How long the caller wants. The grant is min(this, what is left). */
  requestedSeconds: number;
  moduleId?: string | null;
  target: string;
  learner: string;
  level: string;
  model?: string;
  focus?: string | null;
}

export type BeginTutorSessionResult =
  | { ok: true; sessionId: string; grantedSeconds: number; balance: TutorBalance }
  | { ok: false; balance: TutorBalance };

/**
 * Reserve minutes and open a session.
 *
 * Returns `ok: false` when the balance cannot fund one — the caller answers
 * 402 and the client shows the paywall. NOTHING is spent before this returns
 * true: the refusal has to cost nothing, or the fence is just a slower way to
 * pay (lib/spendGuard.ts says the same thing about auth, for the same reason).
 */
export async function beginTutorSession(
  input: BeginTutorSessionInput
): Promise<BeginTutorSessionResult> {
  const balance = await readTutorBalance(input.user);
  const granted = grantSeconds(input.requestedSeconds, balance);
  if (granted <= 0) {
    logTutorSessionEvent({
      event: "start",
      sessionId: "-",
      userId: input.user.id,
      phase: input.phase,
      moduleId: input.moduleId ?? null,
      target: input.target,
      learner: input.learner,
      level: input.level,
      grantedSeconds: 0,
      remainingSeconds: balance.unlimited ? -1 : balance.remainingSeconds
    });
    return { ok: false, balance };
  }

  const sessionId = newTutorSessionId();
  const unmetered = balance.unlimited;

  if (meteringAvailable()) {
    const { error } = await supabaseAdmin.from("tutor_sessions").insert({
      id: sessionId,
      user_id: input.user.id,
      mode: input.phase === "partner" ? "conversation" : input.phase,
      phase: sourceForPhase(input.phase),
      module_id: input.moduleId ?? null,
      learn_lang: input.target,
      learner_lang: input.learner,
      level: input.level,
      focus: input.focus ?? null,
      model: input.model ?? null,
      granted_seconds: granted,
      // -1 means "do not split against a plan": comp and founders.
      cap_plan_seconds: Number.isFinite(balance.planSeconds) ? balance.planSeconds : -1,
      metered: !unmetered,
      seconds: 0
    });
    if (error) {
      // The reservation is the fence. Without a row there is no hold, no
      // debit, and no way to ever settle this session — so refuse rather than
      // mint a realtime session the meter will never see.
      // eslint-disable-next-line no-console
      console.error(`${TUTOR_SESSION_LOG} reserve_failed · ${error.message}`);
      return { ok: false, balance };
    }
  }

  logTutorSessionEvent({
    event: "start",
    sessionId,
    userId: input.user.id,
    phase: input.phase,
    moduleId: input.moduleId ?? null,
    target: input.target,
    learner: input.learner,
    level: input.level,
    model: input.model,
    capSeconds: Math.round(input.requestedSeconds),
    grantedSeconds: granted,
    remainingSeconds: balance.unlimited ? -1 : Math.max(0, balance.remainingSeconds - granted),
    unmetered
  });

  return { ok: true, sessionId, grantedSeconds: granted, balance };
}

export interface SettleTutorSessionInput {
  user: TutorUser;
  sessionId: string;
  /**
   * The server's elapsed seconds, or undefined to let the ledger work it out
   * from `started_at`. Passed explicitly only by Crawl, whose "duration" is
   * the assessed audio's length rather than wall-clock time.
   */
  serverSeconds?: number;
  /** What the browser claimed. Recorded, never billed. */
  clientSeconds?: number | null;
  reason: TutorSessionEndReason;
  phase?: string;
  moduleId?: string | null;
}

/**
 * Close a session and debit what it used.
 *
 * Idempotent by construction: `tutor_accrue` locks the row and returns null if
 * it is already settled, so the `keepalive` beacon being delivered twice (or
 * retried by a flaky network, or replayed after the reaper already collected
 * it) debits once.
 */
export async function settleTutorSession(
  input: SettleTutorSessionInput
): Promise<{ billedSeconds: number | null }> {
  if (!meteringAvailable()) {
    logTutorSessionEvent({
      event: "end",
      sessionId: input.sessionId,
      userId: input.user.id,
      seconds: Math.max(0, Math.round(input.serverSeconds ?? input.clientSeconds ?? 0)),
      reason: input.reason,
      phase: input.phase,
      moduleId: input.moduleId ?? null,
      clientSeconds: input.clientSeconds ?? null,
      unmetered: true
    });
    return { billedSeconds: null };
  }

  const { data: row } = await supabaseAdmin
    .from("tutor_sessions")
    .select("started_at, granted_seconds, settled_at, phase, module_id, metered")
    .eq("id", input.sessionId)
    .eq("user_id", input.user.id)
    .maybeSingle();

  const session = row as {
    started_at?: string;
    granted_seconds?: number;
    settled_at?: string | null;
    phase?: string;
    module_id?: string | null;
    metered?: boolean;
  } | null;

  if (!session || session.settled_at) return { billedSeconds: null };

  // THE authoritative number. Wall clock on the server between the mint and
  // this request, capped at the grant — which is why a browser that reports
  // "3 seconds" after a ten-minute call is recorded and ignored.
  const elapsed =
    typeof input.serverSeconds === "number"
      ? Math.max(0, Math.round(input.serverSeconds))
      : Math.max(0, Math.round((Date.now() - Date.parse(session.started_at ?? "")) / 1000));
  const billed = Math.min(
    Number.isFinite(elapsed) ? elapsed : 0,
    Math.max(0, session.granted_seconds ?? 0)
  );

  const { data: accrued, error } = await supabaseAdmin.rpc("tutor_accrue", {
    p_session_id: input.sessionId,
    p_user_id: input.user.id,
    p_billed_seconds: billed,
    p_client_seconds:
      typeof input.clientSeconds === "number" ? Math.round(input.clientSeconds) : null,
    p_reason: input.reason,
    p_period: tutorPeriod()
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error(`${TUTOR_SESSION_LOG} accrue_failed · ${input.sessionId} · ${error.message}`);
  }

  logTutorSessionEvent({
    event: "end",
    sessionId: input.sessionId,
    userId: input.user.id,
    seconds: billed,
    reason: input.reason,
    phase: session.phase ?? input.phase,
    moduleId: session.module_id ?? input.moduleId ?? null,
    clientSeconds: input.clientSeconds ?? null,
    unmetered: session.metered === false
  });

  return { billedSeconds: typeof accrued === "number" ? accrued : billed };
}
