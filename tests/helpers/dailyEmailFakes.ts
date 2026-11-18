// An in-memory daily_email_prefs and a provider that only counts — shared by
// the daily-email tests. The store obeys the same conditions the real one
// puts in its queries (lib/email/store.ts): listSendable filters the same
// four columns, and claim() is the same compare-and-set.

import { localMoment, withVisit } from "@/lib/email/schedule";
import type { EmailProvider, OutgoingEmail, SendResult } from "@/lib/email/provider";
import type { PrefsRow, PrefsStore, ReadResult } from "@/lib/email/store";

export const ENV = {
  RESEND_API_KEY: "re_test_key",
  TAOS_EMAIL_FROM: "TAOS <hola@example.test>",
  TAOS_EMAIL_FOOTER_ADDRESS: "1 Test Plaza, Testville, NM 87571",
  TAOS_EMAIL_LINK_SECRET: "link-secret-for-tests",
  TAOS_DAILY_EMAIL: "all"
};

export const TOM = { id: "11111111-1111-4111-8111-111111111111", email: "xdrabbit@gmail.com" };
export const LIZ = { id: "22222222-2222-4222-8222-222222222222", email: "lizmariett@gmail.com" };
export const CUSTOMER = { id: "33333333-3333-4333-8333-333333333333", email: "someone@example.test" };

export function row(user: { id: string }, over: Partial<PrefsRow> = {}): PrefsRow {
  return {
    user_id: user.id,
    opted_in: true,
    time_zone: "America/Denver",
    send_hour: 8,
    lang: "en",
    last_sent_day: null,
    last_visit_at: null,
    visit_days: [],
    opted_in_at: "2026-11-17T12:00:00Z",
    paused: false,
    unsubscribed_at: null,
    bounced: false,
    unsubscribe_token: `token-${user.id.slice(0, 4)}`,
    last_message_id: null,
    ...over
  };
}

export interface FakeStore extends PrefsStore {
  rows: Map<string, PrefsRow>;
  emails: Map<string, string>;
  conversations: Set<string>;
  missing: boolean;
  calls: string[];
}

export function fakeStore(rows: PrefsRow[] = [], users = [TOM, LIZ, CUSTOMER]): FakeStore {
  const store: FakeStore = {
    rows: new Map(rows.map((r) => [r.user_id, { ...r }])),
    emails: new Map(users.map((u) => [u.id, u.email])),
    conversations: new Set(),
    missing: false,
    calls: [],
    async read(userId): Promise<ReadResult> {
      store.calls.push("read");
      if (store.missing) return { state: "unavailable" };
      const found = store.rows.get(userId);
      return { state: "ok", row: found ? { ...found } : null };
    },
    async save(userId, patch) {
      store.calls.push("save");
      if (store.missing) return null;
      const next = { ...(store.rows.get(userId) ?? row({ id: userId }, { opted_in: false, opted_in_at: null })), ...patch, user_id: userId };
      store.rows.set(userId, next);
      return { ...next };
    },
    async listSendable(limit) {
      store.calls.push("listSendable");
      if (store.missing) return "unavailable";
      return [...store.rows.values()]
        .filter((r) => r.opted_in && !r.paused && !r.bounced && !r.unsubscribed_at)
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async claim(userId, day, pause) {
      store.calls.push("claim");
      const r = store.rows.get(userId);
      if (!r || !r.opted_in || r.paused || r.bounced || r.unsubscribed_at) return false;
      if (r.last_sent_day && r.last_sent_day >= day) return false;
      r.last_sent_day = day;
      if (pause) r.paused = true;
      return true;
    },
    async release(userId, day, previousDay, pause) {
      store.calls.push("release");
      const r = store.rows.get(userId);
      if (!r || r.last_sent_day !== day) return;
      r.last_sent_day = previousDay;
      if (pause) r.paused = false;
    },
    async recordSent(userId, messageId) {
      const r = store.rows.get(userId);
      if (r && messageId) r.last_message_id = messageId;
    },
    async recordVisit(userId, now) {
      store.calls.push("recordVisit");
      if (store.missing) return { state: "unavailable" };
      const r = store.rows.get(userId);
      if (!r) return { state: "ok", row: null };
      r.last_visit_at = now.toISOString();
      r.visit_days = withVisit(r.visit_days, localMoment(now, r.time_zone).day);
      r.paused = false;
      return { state: "ok", row: { ...r } };
    },
    async unsubscribe(userId) {
      const r = store.rows.get(userId);
      if (!r) return false;
      r.opted_in = false;
      r.unsubscribed_at = "2026-11-18T00:00:00Z";
      return true;
    },
    async flagBounce(userId) {
      const r = store.rows.get(userId);
      if (!r) return false;
      r.bounced = true;
      r.opted_in = false;
      return true;
    },
    async userForMessage(messageId) {
      return [...store.rows.values()].find((r) => r.last_message_id === messageId)?.user_id ?? null;
    },
    async emailFor(userId) {
      return store.emails.get(userId) ?? null;
    },
    async hasConversations(userId) {
      return store.conversations.has(userId);
    }
  };
  return store;
}

export interface FakeProvider extends EmailProvider {
  sent: OutgoingEmail[];
  /** Results to hand out, in order; after that every send succeeds. */
  queue: SendResult[];
}

export function fakeProvider(): FakeProvider {
  const provider: FakeProvider = {
    name: "fake",
    sent: [],
    queue: [],
    async send(email) {
      const next = provider.queue.shift();
      if (next && !next.ok) return next;
      provider.sent.push(email);
      return next ?? { ok: true, id: `msg-${provider.sent.length}` };
    }
  };
  return provider;
}
