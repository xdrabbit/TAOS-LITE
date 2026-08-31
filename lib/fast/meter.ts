// The /fast cash register.
//
// ── What was wrong ─────────────────────────────────────────────────────────
// #46 shipped /fast with the meter in the browser. `POST /api/fast` checked
// who was calling and how fast, and then translated without ever asking what
// the month's allowance had left; the bill was a `saveTranslation(...)` in
// FastShell, fired 1500ms after the typing stopped, wrapped in `.catch(() =>
// {})`. Everything about that is fail-open. A curl with a valid session never
// runs it. A tab closed at 1400ms never runs it. A failed write is swallowed
// by design. The allowance did not move, and nothing on the server noticed.
//
// The route's own comment gave the reason, and the reason was wrong: it said
// the server "sees each preview individually and has no way to know which one
// was the last". True about any single request, false about the stream. The
// client's settle measures A PAUSE IN TYPING — and the gap between two
// requests from one account is that same pause, measured on a clock nobody
// can edit.
//
// ── So: the burst is the unit ──────────────────────────────────────────────
// A BURST is a contiguous run of previews from one account, in one requested
// direction, with no gap longer than FAST_SETTLE_MS. One burst is one billed
// quickie, however many keystrokes it took — which is the rule
// lib/fast/settle.ts always described, now enforced where it cannot be
// skipped. The two models agree on the cases that matter:
//
//   type "bathroom" straight through   → 1 preview run, no gap    → 1
//   pause 1.0s mid-phrase, keep typing → under the window         → 1
//   pause 2s, then add a word          → new burst; client would
//                                        have settled and re-billed → 2
//   tap swap and re-run the same words → different direction      → 2
//
// The last is deliberate and matches what the client did: the same words the
// other way round is a different question.
//
// ── The order of operations ────────────────────────────────────────────────
// Check, then serve. `beginFastQuickie` takes the allowance BEFORE
// `fastTranslate` is called, exactly as lib/tutor/meter.ts reserves minutes
// before minting a realtime session, and for the reason lib/spendGuard.ts
// gives about auth: a refusal that happens after the provider has been paid
// is the same bill with better manners.
//
// The reservation IS the row in taos_lite_translations — the same table the
// free allowance is counted from (lib/supabase.ts getMonthlyUsage), so /fast
// keeps spending from the one meter the whole app shares rather than growing
// a private counter that would have to be reconciled later. It goes in with
// an empty translation, `recordFastQuickie` fills it, and
// `abandonFastQuickie` deletes it if the engine falls over: nobody is billed
// for a translation they never received.

import { isFounder } from "@/lib/release";
import type { Tier } from "@/lib/supabase";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  FAST_REPEAT_MIN_CHARS,
  FAST_REPEAT_MIN_RATIO,
  FAST_REPEAT_MS,
  FAST_REPEAT_STRONG_CHARS,
  FAST_SETTLE_MS
} from "./settle";

/** The one log prefix for this meter. Change it here, dashboards follow. */
export const FAST_METER_LOG = "taos.fast.meter";

/** Tone stamped on a /fast row. The register that makes this screen /fast. */
export const FAST_TONE = "literal";

/**
 * The monthly translation allowance per tier, as the database sees it.
 *
 * These are the numbers on the pricing page and in `QUOTAS` in
 * lib/supabase.ts, which is what the browser reads. Restated here rather than
 * imported for the reason lib/tutor/meter.ts restates TUTOR_PLAN_SECONDS:
 * lib/supabase.ts builds a BROWSER Supabase client at module scope, and this
 * file runs on the server. tests/fast-metering.test.ts pins the two lists
 * together so they cannot drift — a tier that says unlimited in the UI and
 * enforces 25 on the server is a support email that looks like a bug.
 *
 * -1 is unlimited: `Infinity` does not survive the trip through JSON into
 * Postgres, and the SQL reads a negative cap as "do not check".
 */
export const FAST_PLAN_TRANSLATIONS: Record<Tier, number> = {
  free: 25,
  basic: -1,
  premium: -1,
  comp: -1
};

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * The durable ceilings, in the same two windows lib/fast/rateLimit.ts uses
 * and off the same environment variables — so raising the cap raises both the
 * free in-process fast path and the ceiling that actually holds.
 */
export function fastRateLimits(): { perMinute: number; perHour: number } {
  return {
    perMinute: numberFromEnv("TAOS_FAST_RATE_PER_MINUTE", 60),
    perHour: numberFromEnv("TAOS_FAST_RATE_PER_HOUR", 600)
  };
}

export interface FastUser {
  id: string;
  email?: string | null;
}

export type FastRefusal = "rate_minute" | "rate_hour" | "quota";

export type BeginFastQuickieResult =
  | {
      ok: true;
      rowId: string | null;
      billed: boolean;
      /**
       * True when this request ADOPTED a row an earlier lookup already paid
       * for (the repeat window). The row belongs to that lookup, so the
       * caller must not write over it — see recordFastQuickie.
       */
      repeat: boolean;
      used?: number;
      cap?: number;
    }
  | { ok: false; reason: FastRefusal; used?: number; cap?: number };

/** Raised when production is missing the key the meter cannot work without. */
export class FastMeterUnavailableError extends Error {
  constructor() {
    super(
      "Fast metering is unavailable: SUPABASE_SERVICE_ROLE_KEY is not set. " +
        "Refusing to serve an unmetered translation in production."
    );
    this.name = "FastMeterUnavailableError";
  }
}

function inProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
}

/**
 * Whether the meter can actually meter.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is marked sensitive in Vercel, so `vercel env
 * pull` returns an empty string and a laptop never has one. That is fine
 * locally and NOT fine in production, where a missing key would turn this
 * whole file back into the open door it exists to close — silently, on the
 * exact deploy that opened /fast to customers. Same rule, same shape, as
 * lib/tutor/meter.ts: unmetered-with-a-loud-log off production, hard refusal
 * on it.
 */
function meteringAvailable(): boolean {
  return hasServiceRoleKey;
}

function unmeteredWarning(): void {
  // eslint-disable-next-line no-console
  console.warn(`${FAST_METER_LOG} meter_unavailable · no service-role key · unmetered`);
}

export interface BeginFastQuickieInput {
  user: FastUser;
  /** The direction AS REQUESTED. In auto mode this is the pair, in order. */
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
  /** True when the caller did not say which side the text is written in. */
  auto?: boolean;
}

/**
 * Count the request, take the allowance if this opens a new quickie, and say
 * whether the engine may be called.
 *
 * One round trip, because this runs while somebody is typing: the route
 * already spends a debounce and a provider call, and three separate trips to
 * decide whether to spend them would be felt on the screen whose entire
 * virtue is speed.
 */
export async function beginFastQuickie(
  input: BeginFastQuickieInput
): Promise<BeginFastQuickieResult> {
  if (!meteringAvailable()) {
    if (inProduction()) throw new FastMeterUnavailableError();
    unmeteredWarning();
    return { ok: true, rowId: null, billed: false, repeat: false };
  }

  const { perMinute, perHour } = fastRateLimits();
  const { data, error } = await supabaseAdmin.rpc("fast_begin", {
    p_user_id: input.user.id,
    p_source_lang: input.sourceLanguage,
    p_target_lang: input.targetLanguage,
    p_text: input.text,
    p_caps: FAST_PLAN_TRANSLATIONS,
    // A founder bypass, because "who is a founder" is a question about an
    // EMAIL (lib/release.ts) and the database has no opinion about it. Both
    // founders are subscribers today, so this changes nothing yet — it is
    // here so that adding a founder by env var cannot lock them out of the
    // screen the founders gate exists to give them.
    p_unlimited: isFounder(input.user.email),
    p_window_ms: FAST_SETTLE_MS,
    p_minute_limit: perMinute,
    p_hour_limit: perHour,
    // The visit-long billed set, restored durably (lib/fast/settle.ts). A
    // phrase asked again inside this window adopts the row it already bought
    // — but only once enough of it has been typed to be that phrase and not
    // an opener every row in the table starts with. One bag rather than four
    // arguments, so the next knob to move does not change the SQL signature
    // again; the function reads its own defaults from it.
    p_repeat: {
      ms: FAST_REPEAT_MS,
      min_chars: FAST_REPEAT_MIN_CHARS,
      min_ratio: FAST_REPEAT_MIN_RATIO,
      strong_chars: FAST_REPEAT_STRONG_CHARS
    },
    p_auto: Boolean(input.auto)
  });

  if (error) {
    // No verdict means no reservation, and no reservation means this
    // translation would be free. Refuse rather than serve it — the same call
    // lib/tutor/meter.ts makes when its reservation insert fails.
    // eslint-disable-next-line no-console
    console.error(`${FAST_METER_LOG} begin_failed · ${error.message}`);
    throw new FastMeterUnavailableError();
  }

  const verdict = (data ?? {}) as {
    ok?: boolean;
    billed?: boolean;
    repeat?: boolean;
    row_id?: string | null;
    reason?: FastRefusal;
    used?: number;
    cap?: number;
  };

  if (!verdict.ok) {
    return {
      ok: false,
      reason: verdict.reason ?? "quota",
      used: verdict.used,
      cap: verdict.cap
    };
  }

  return {
    ok: true,
    rowId: verdict.row_id ?? null,
    billed: Boolean(verdict.billed),
    repeat: Boolean(verdict.repeat),
    used: verdict.used,
    cap: verdict.cap
  };
}

export interface RecordFastQuickieInput {
  user: FastUser;
  rowId: string | null;
  /** True when the row was adopted from an earlier lookup. Then: hands off. */
  repeat?: boolean;
  /** What the engine says was typed — auto mode only learns it here. */
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
  translation: string;
  engine: string;
}

/**
 * Fill in the reserved row.
 *
 * Best effort by design, and the one place in this file that is: the money
 * already moved in `beginFastQuickie`. A failure here costs a History entry
 * its text, not an allowance its count.
 *
 * Does nothing for an ADOPTED row. That row belongs to an earlier lookup — it
 * is already settled, with its own finished text and translation — and writing
 * this preview into it would overwrite that History entry with a prefix of
 * itself. `fast_begin` guards the same row on the SQL side for the same
 * reason; this is the other half of it, and without it the repeat window
 * would quietly eat the answer it just saved somebody from re-buying.
 */
export async function recordFastQuickie(input: RecordFastQuickieInput): Promise<void> {
  if (input.repeat) return;
  if (!input.rowId || !meteringAvailable()) return;
  const { error } = await supabaseAdmin.rpc("fast_record", {
    p_user_id: input.user.id,
    p_row_id: input.rowId,
    p_source_lang: input.sourceLanguage,
    p_target_lang: input.targetLanguage,
    p_text: input.text,
    p_translation: input.translation,
    p_engine: input.engine
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`${FAST_METER_LOG} record_failed · ${input.rowId} · ${error.message}`);
  }
}

/**
 * Give the reservation back when the engine could not answer.
 *
 * Charging for a translation that never arrived would be the mirror image of
 * the bug this file fixes, so the refund is not optional — but it also cannot
 * be allowed to turn a provider error into a 500, which is why it swallows
 * its own.
 */
export async function abandonFastQuickie(user: FastUser, rowId: string | null): Promise<void> {
  if (!rowId || !meteringAvailable()) return;
  const { error } = await supabaseAdmin.rpc("fast_abandon", {
    p_user_id: user.id,
    p_row_id: rowId
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`${FAST_METER_LOG} abandon_failed · ${rowId} · ${error.message}`);
  }
}

/** What a refused caller is told, and with what status. */
export function fastRefusal(reason: FastRefusal): { status: number; message: string } {
  if (reason === "quota") {
    return {
      status: 402,
      message:
        "This month's translations are used up. Upgrade for unlimited · " +
        "Se acabaron las traducciones de este mes."
    };
  }
  return {
    status: 429,
    message: "Too many translations in a row. Give it a moment."
  };
}
