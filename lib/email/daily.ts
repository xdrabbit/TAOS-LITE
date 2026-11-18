// One pass of the hourly cron: who is due right now, and send to them.
//
// Called by GET /api/email/daily. Everything it touches is handed in (the
// store, the provider, the clock, the env), so tests/daily-email.test.ts runs
// this exact function against an in-memory table and a provider that only
// counts.
//
// ORDER, per person, and why:
//   1. due?      their local hour and day (lib/email/schedule.ts)
//   2. audience? re-checked at send time — the knob may have moved since
//                they opted in, and the shared account is never mailed
//   3. CLAIM     stamp today on the row, conditionally. Only the run that
//                changes the stamp sends. Two crons at once → one email.
//   4. send      with an idempotency key of user+day, so even a claim that
//                was released and re-taken cannot produce a second email
//   5. on a failed send, RELEASE the claim so the next hour's run (inside the
//      catch-up window) tries again. A crash between 3 and 4 costs that
//      person one day's email; it can never cost them two.
//
// LOGS: fields only. Counts, the user's uuid, an outcome word. Never an
// address, never a subject, never a phrase.

import { studyEnabled, tutorEnabled } from "@/lib/release";
import {
  audienceAllows,
  dailyEmailAudience,
  emailSettings,
  missingEmailEnv,
  PAUSE_AFTER_DAYS,
  type DailyEmailAudience
} from "./config";
import { emailLang } from "./copy";
import { phraseForDay } from "./phrases";
import { resendProvider, type EmailProvider } from "./provider";
import { renderEmail, type EmailDestination, type EmailKind } from "./render";
import { daysThisWeek, isDue, localMoment, shouldPause } from "./schedule";
import { supabasePrefsStore, type PrefsStore } from "./store";
import { unsubscribeUrl } from "./token";

export const LOG = "[taos-daily-email]";

/** Most rows one run will look at. Past this the log says `more=1`. */
export const RUN_LIMIT = 2000;

export interface RunOptions {
  now?: Date;
  /** Where links point: https://taoslite.com, no trailing slash. */
  origin: string;
  env?: Record<string, string | undefined>;
  store?: PrefsStore;
  provider?: EmailProvider;
  /** Which screens exist. Defaults to the release flags. */
  screens?: { study: boolean; tutor: boolean };
  log?: (line: string) => void;
}

export interface RunResult {
  state: "off" | "inert" | "no_table" | "no_screen" | "ran";
  audience: DailyEmailAudience;
  candidates: number;
  due: number;
  sent: number;
  paused: number;
  failed: number;
  skipped: number;
}

export async function runDailyEmails(options: RunOptions): Promise<RunResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? new Date();
  const audience = dailyEmailAudience(env.TAOS_DAILY_EMAIL);
  const result: RunResult = { state: "ran", audience, candidates: 0, due: 0, sent: 0, paused: 0, failed: 0, skipped: 0 };

  if (audience === "off") {
    log(`${LOG} run state=off`);
    return { ...result, state: "off" };
  }
  const settings = emailSettings(env);
  if (!settings) {
    // The one line. Names only — a missing key has no value to leak, and a
    // present one is not mentioned.
    log(`${LOG} run state=inert missing=${missingEmailEnv(env).join(",")}`);
    return { ...result, state: "inert" };
  }
  const screens = options.screens ?? { study: studyEnabled(), tutor: tutorEnabled() };
  if (!screens.study && !screens.tutor) {
    log(`${LOG} run state=no_screen`);
    return { ...result, state: "no_screen" };
  }

  const store = options.store ?? supabasePrefsStore;
  const provider = options.provider ?? resendProvider(settings.apiKey);
  const rows = await store.listSendable(RUN_LIMIT + 1);
  if (rows === "unavailable") {
    log(`${LOG} run state=no_table`);
    return { ...result, state: "no_table" };
  }
  const more = rows.length > RUN_LIMIT;
  result.candidates = Math.min(rows.length, RUN_LIMIT);

  for (const row of rows.slice(0, RUN_LIMIT)) {
    const local = localMoment(now, row.time_zone);
    if (!isDue(local, row)) continue;
    result.due += 1;

    const address = await store.emailFor(row.user_id);
    if (!audienceAllows(audience, address) || !address) {
      result.skipped += 1;
      log(`${LOG} send user=${row.user_id} outcome=skipped_audience`);
      continue;
    }

    const kind: EmailKind = shouldPause(row, now) ? "paused" : "daily";
    if (!(await store.claim(row.user_id, local.day, kind === "paused"))) {
      result.skipped += 1;
      log(`${LOG} send user=${row.user_id} outcome=already_claimed`);
      continue;
    }

    const destination: EmailDestination =
      screens.study && (!screens.tutor || (await store.hasConversations(row.user_id))) ? "study" : "tutor";
    const unsubscribe = unsubscribeUrl(options.origin, row.user_id, row.unsubscribe_token, settings.linkSecret);
    const email = renderEmail({
      kind,
      lang: row.lang,
      phrase: phraseForDay(local.day),
      daysThisWeek: daysThisWeek(row.visit_days, local.day),
      destination,
      origin: options.origin,
      unsubscribeUrl: unsubscribe,
      footerAddress: settings.footerAddress
    });

    const sent = await provider.send({
      from: settings.from,
      to: address,
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: {
        "List-Unsubscribe": `<${unsubscribe}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      },
      tags: { uid: row.user_id, kind },
      idempotencyKey: `taos-daily-${row.user_id}-${local.day}`
    });

    if (!sent.ok && sent.status === 409) {
      // The provider already has this person's email for today under this
      // key (an earlier attempt that we thought had failed). Keep the claim.
      result.skipped += 1;
      log(`${LOG} send user=${row.user_id} outcome=already_sent kind=${kind}`);
      continue;
    }
    if (!sent.ok) {
      result.failed += 1;
      // Retryable or not, let go of the claim: a non-retryable refusal today
      // (a bad `from`, say) is a setup fault Tom fixes, and the person should
      // get their email once he has. The idempotency key stops a double.
      await store.release(row.user_id, local.day, row.last_sent_day, kind === "paused");
      log(`${LOG} send user=${row.user_id} outcome=failed status=${sent.status} retryable=${sent.retryable ? 1 : 0} kind=${kind}`);
      continue;
    }
    await store.recordSent(row.user_id, sent.id);
    if (kind === "paused") result.paused += 1;
    else result.sent += 1;
    log(`${LOG} send user=${row.user_id} outcome=sent kind=${kind} dest=${destination} lang=${emailLang(row.lang)}`);
  }

  log(
    `${LOG} run state=ran audience=${audience} candidates=${result.candidates} due=${result.due}` +
      ` sent=${result.sent} paused=${result.paused} failed=${result.failed} skipped=${result.skipped}` +
      ` pause_after_days=${PAUSE_AFTER_DAYS} more=${more ? 1 : 0}`
  );
  return result;
}
