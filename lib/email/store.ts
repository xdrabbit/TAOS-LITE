// daily_email_prefs — every read and write of it.
//
// One row per person who has ever turned the reminder on
// (supabase/migrations/20261118_daily_email_prefs.sql). All access here is
// through the service role, after the route has checked who is asking.
//
// THE TABLE MAY NOT EXIST. The migration ships as a file and is applied by
// hand, later. Until then every function here answers `unavailable` (or
// false, or null) instead of throwing, the toggle is not drawn, and the cron
// logs one line and stops. That is the whole of "hides itself cleanly".
//
// The one thing this file reads outside its own table is a COUNT of the
// user's translations ("is there anything to study?") — `head: true`, so not
// one character of what they said comes back.

import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { localMoment, withVisit } from "./schedule";

export const PREFS_TABLE = "daily_email_prefs";
const TRANSLATIONS_TABLE = "taos_lite_translations";

export interface PrefsRow {
  user_id: string;
  opted_in: boolean;
  time_zone: string;
  send_hour: number;
  lang: string;
  last_sent_day: string | null;
  last_visit_at: string | null;
  visit_days: string[] | null;
  opted_in_at: string | null;
  paused: boolean;
  unsubscribed_at: string | null;
  bounced: boolean;
  unsubscribe_token: string;
  last_message_id: string | null;
}

/** `row: null` = the table is there and this person has no row. */
export type ReadResult = { state: "ok"; row: PrefsRow | null } | { state: "unavailable" };

export interface PrefsStore {
  read(userId: string): Promise<ReadResult>;
  /** Create or change the caller's row. Null when the table is not there. */
  save(userId: string, patch: Partial<PrefsRow>): Promise<PrefsRow | null>;
  /** Rows that may be mailed at all, or `unavailable`. */
  listSendable(limit: number): Promise<PrefsRow[] | "unavailable">;
  /** Stamp today on the row IF it is not already stamped. True = we hold it. */
  claim(userId: string, day: string, pause: boolean): Promise<boolean>;
  /** Undo a claim after a failed send, so a later run may try again. */
  release(userId: string, day: string, previousDay: string | null, pause: boolean): Promise<void>;
  recordSent(userId: string, messageId: string | null): Promise<void>;
  recordVisit(userId: string, now: Date): Promise<ReadResult>;
  unsubscribe(userId: string): Promise<boolean>;
  flagBounce(userId: string): Promise<boolean>;
  userForMessage(messageId: string): Promise<string | null>;
  emailFor(userId: string): Promise<string | null>;
  hasConversations(userId: string): Promise<boolean>;
}

function db() {
  return supabaseAdmin.from(PREFS_TABLE);
}

export const supabasePrefsStore: PrefsStore = {
  async read(userId) {
    if (!hasServiceRoleKey) return { state: "unavailable" };
    try {
      const { data, error } = await db().select("*").eq("user_id", userId).maybeSingle();
      if (error) return { state: "unavailable" };
      return { state: "ok", row: (data as PrefsRow | null) ?? null };
    } catch {
      return { state: "unavailable" };
    }
  },

  async save(userId, patch) {
    if (!hasServiceRoleKey) return null;
    try {
      const { data, error } = await db()
        .upsert({ ...patch, user_id: userId, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
        .select("*")
        .maybeSingle();
      return error ? null : ((data as PrefsRow | null) ?? null);
    } catch {
      return null;
    }
  },

  async listSendable(limit) {
    if (!hasServiceRoleKey) return "unavailable";
    const rows: PrefsRow[] = [];
    try {
      // PostgREST hands back at most 1,000 rows a read, silently — page.
      for (let from = 0; rows.length < limit; from += 1000) {
        const { data, error } = await db()
          .select("*")
          .eq("opted_in", true)
          .eq("paused", false)
          .eq("bounced", false)
          .is("unsubscribed_at", null)
          .order("user_id")
          .range(from, from + 999);
        if (error) return "unavailable";
        rows.push(...((data ?? []) as PrefsRow[]));
        if ((data ?? []).length < 1000) break;
      }
    } catch {
      return "unavailable";
    }
    return rows.slice(0, limit);
  },

  async claim(userId, day, pause) {
    try {
      const { data, error } = await db()
        .update({ last_sent_day: day, ...(pause ? { paused: true } : {}) })
        .eq("user_id", userId)
        .eq("opted_in", true)
        .eq("paused", false)
        .eq("bounced", false)
        .is("unsubscribed_at", null)
        .or(`last_sent_day.is.null,last_sent_day.lt.${day}`)
        .select("user_id");
      return !error && (data ?? []).length === 1;
    } catch {
      return false;
    }
  },

  async release(userId, day, previousDay, pause) {
    try {
      await db()
        .update({ last_sent_day: previousDay, ...(pause ? { paused: false } : {}) })
        .eq("user_id", userId)
        .eq("last_sent_day", day);
    } catch {
      /* the claim stands: one email fewer, never one more */
    }
  },

  async recordSent(userId, messageId) {
    if (!messageId) return;
    try {
      await db().update({ last_message_id: messageId }).eq("user_id", userId);
    } catch {
      /* only the bounce fallback loses out */
    }
  },

  async recordVisit(userId, now) {
    const current = await this.read(userId);
    if (current.state !== "ok" || !current.row) return current;
    const row = current.row;
    const today = localMoment(now, row.time_zone).day;
    const patch = {
      last_visit_at: now.toISOString(),
      visit_days: withVisit(row.visit_days, today),
      // Coming back is what un-pauses. The 21 days start again from now.
      paused: false
    };
    try {
      const { error } = await db().update(patch).eq("user_id", userId);
      if (error) return current;
    } catch {
      return current;
    }
    return { state: "ok", row: { ...row, ...patch } };
  },

  async unsubscribe(userId) {
    try {
      const { data, error } = await db()
        .update({ opted_in: false, unsubscribed_at: new Date().toISOString() })
        .eq("user_id", userId)
        .select("user_id");
      return !error && (data ?? []).length === 1;
    } catch {
      return false;
    }
  },

  async flagBounce(userId) {
    try {
      const { data, error } = await db()
        .update({ bounced: true, opted_in: false })
        .eq("user_id", userId)
        .select("user_id");
      return !error && (data ?? []).length === 1;
    } catch {
      return false;
    }
  },

  async userForMessage(messageId) {
    try {
      const { data, error } = await db().select("user_id").eq("last_message_id", messageId).limit(1);
      const row = (data ?? [])[0] as { user_id?: string } | undefined;
      return error ? null : (row?.user_id ?? null);
    } catch {
      return null;
    }
  },

  async emailFor(userId) {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
      return error ? null : (data.user?.email ?? null);
    } catch {
      return null;
    }
  },

  async hasConversations(userId) {
    try {
      const { count, error } = await supabaseAdmin
        .from(TRANSLATIONS_TABLE)
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      return !error && (count ?? 0) > 0;
    } catch {
      return false;
    }
  }
};
