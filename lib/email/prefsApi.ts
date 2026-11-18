// What the browser is told about the reminder, and what it may change.
//
// GET  /api/email/prefs                → { available, prefs? }
// POST /api/email/prefs {action:"visit", dest, src?} → same, and notes the visit
// POST /api/email/prefs {action:"set", optedIn, hour?, timeZone?, lang?} → same
//
// `available: false` is the answer for every reason the toggle must not be
// drawn — audience off, caller outside the audience, the shared account, a
// missing env var, no service role, no table. The browser is not told which:
// it draws nothing either way, and the reason is nobody's business but ours.

import type { User } from "@supabase/supabase-js";
import { audienceAllows, dailyEmailAudience, DEFAULT_SEND_HOUR, EMAIL_SOURCE, missingEmailEnv } from "./config";
import { emailLang } from "./copy";
import { isValidTimeZone } from "./schedule";
import { supabasePrefsStore, type PrefsRow, type PrefsStore } from "./store";

export interface PrefsView {
  optedIn: boolean;
  hour: number;
  timeZone: string;
  paused: boolean;
  bounced: boolean;
}

export type PrefsPayload = { available: false } | { available: true; prefs: PrefsView };

const UNAVAILABLE: PrefsPayload = { available: false };

function view(row: PrefsRow | null): PrefsView {
  return {
    optedIn: Boolean(row?.opted_in) && !row?.bounced && !row?.unsubscribed_at,
    hour: row?.send_hour ?? DEFAULT_SEND_HOUR,
    timeZone: row?.time_zone ?? "",
    paused: Boolean(row?.paused),
    bounced: Boolean(row?.bounced)
  };
}

interface Deps {
  env?: Record<string, string | undefined>;
  store?: PrefsStore;
  now?: Date;
  log?: (line: string) => void;
}

function allowed(user: User, env: Record<string, string | undefined>): boolean {
  if (missingEmailEnv(env).length) return false;
  return audienceAllows(dailyEmailAudience(env.TAOS_DAILY_EMAIL), user.email);
}

export async function readPrefs(user: User, deps: Deps = {}): Promise<PrefsPayload> {
  if (!allowed(user, deps.env ?? process.env)) return UNAVAILABLE;
  const found = await (deps.store ?? supabasePrefsStore).read(user.id);
  return found.state === "ok" ? { available: true, prefs: view(found.row) } : UNAVAILABLE;
}

/**
 * A visit to /study or /tutor. Resets the 21-day clock, un-pauses, and — when
 * the visit carries the email's source marker — counts one open. The count is
 * a log line: a uuid and a destination, nothing else.
 */
export async function noteVisit(user: User, body: Record<string, unknown>, deps: Deps = {}): Promise<PrefsPayload> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const dest = body.dest === "study" ? "study" : body.dest === "tutor" ? "tutor" : null;
  if (!dest || !allowed(user, deps.env ?? process.env)) return UNAVAILABLE;
  const found = await (deps.store ?? supabasePrefsStore).recordVisit(user.id, deps.now ?? new Date());
  if (found.state !== "ok") return UNAVAILABLE;
  if (body.src === EMAIL_SOURCE) log(`[taos-daily-email] open user=${user.id} dest=${dest} src=${EMAIL_SOURCE}`);
  return { available: true, prefs: view(found.row) };
}

export async function setPrefs(user: User, body: Record<string, unknown>, deps: Deps = {}): Promise<PrefsPayload> {
  const log = deps.log ?? ((line: string) => console.log(line));
  if (!allowed(user, deps.env ?? process.env)) return UNAVAILABLE;
  const store = deps.store ?? supabasePrefsStore;
  const found = await store.read(user.id);
  if (found.state !== "ok") return UNAVAILABLE;
  const row = found.row;
  const now = (deps.now ?? new Date()).toISOString();

  const patch: Partial<PrefsRow> = {};
  if (typeof body.hour === "number" && Number.isInteger(body.hour) && body.hour >= 0 && body.hour <= 23) {
    patch.send_hour = body.hour;
  }
  if (isValidTimeZone(body.timeZone)) patch.time_zone = body.timeZone;
  if (typeof body.lang === "string") patch.lang = emailLang(body.lang);

  if (body.optedIn === true) {
    // An address that bounced stays off. Turning the toggle on cannot make a
    // dead mailbox live, and mailing it again is how a sender gets blocked.
    if (row?.bounced) return { available: true, prefs: view(row) };
    // Opting in needs the person's own clock — never guess a time zone.
    if (!patch.time_zone && !row?.time_zone) return { available: true, prefs: view(row) };
    Object.assign(patch, {
      opted_in: true,
      opted_in_at: now,
      last_visit_at: now,
      paused: false,
      // Their own hand on the toggle is what undoes an unsubscribe.
      unsubscribed_at: null
    });
  } else if (body.optedIn === false) {
    patch.opted_in = false;
  }
  // Nothing to keep for someone who has never turned it on.
  if (!row && patch.opted_in !== true) return { available: true, prefs: view(null) };

  const saved = await store.save(user.id, patch);
  if (!saved) return UNAVAILABLE;
  if (typeof body.optedIn === "boolean") {
    log(`[taos-daily-email] prefs user=${user.id} opted_in=${saved.opted_in ? 1 : 0} hour=${saved.send_hour}`);
  }
  return { available: true, prefs: view(saved) };
}
