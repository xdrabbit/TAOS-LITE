// The daily study reminder, pinned (Tom, 2026-11-18: "we want them to invite
// us into their lives every day" — built as an opt-in habit, not a broadcast).
//
// What this file fences, each against the rule it came from:
//
//   1. OPT-IN ONLY          nobody is mailed who did not turn it on.
//   2. AUDIENCE KNOB        TAOS_DAILY_EMAIL = off | founders | all, default
//                           founders; a typo is founders, never all.
//   3. THEIR OWN CLOCK      the hour is matched in the person's time zone,
//                           through both DST changes.
//   4. ONCE A DAY           a doubled cron, two crons at once, and a skipped
//                           hour all end in exactly one email.
//   5. UNSUBSCRIBE          a signed link that works signed-out; the email
//                           carries the one-click headers.
//   6. DON'T NAG            21 days without a visit → ONE "paused" email,
//                           then silence; a bounced address is never mailed.
//   7. INERT WITHOUT KEYS   a missing env var is one log line, no send, no
//                           toggle, no error. No footer address, no send.
//   8. NO CONVERSATION TEXT the email is built from the course files only.
//   9. LOGS ARE FIELDS      a uuid and an outcome; never an address.
//
// runDailyEmails is the real function the cron route calls. What is faked is
// the far side: the table (tests/helpers/dailyEmailFakes.ts) and the provider.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { User } from "@supabase/supabase-js";
import {
  audienceAllows,
  dailyEmailAudience,
  missingEmailEnv,
  PAUSE_AFTER_DAYS,
  REQUIRED_ENV,
  SHARED_ACCOUNT_EMAIL
} from "@/lib/email/config";
import { EMAIL_COPY, emailLang } from "@/lib/email/copy";
import { runDailyEmails } from "@/lib/email/daily";
import { DAILY_PHRASES, phraseForDay } from "@/lib/email/phrases";
import { noteVisit, readPrefs, setPrefs } from "@/lib/email/prefsApi";
import { resendProvider } from "@/lib/email/provider";
import { renderEmail } from "@/lib/email/render";
import { daysThisWeek, isDue, isValidTimeZone, localMoment, shouldPause, withVisit } from "@/lib/email/schedule";
import { signUnsubscribe, unsubscribeUrl, verifyUnsubscribe } from "@/lib/email/token";
import { unsubscribePage } from "@/lib/email/unsubscribePage";
import { parseDeliveryEvent, signWebhook, verifyWebhook } from "@/lib/email/webhook";
import { CUSTOMER, ENV, fakeProvider, fakeStore, LIZ, row, TOM } from "./helpers/dailyEmailFakes";

const ORIGIN = "https://taoslite.com";
const SCREENS = { study: true, tutor: true };
const at = (iso: string): Date => new Date(iso);
const asUser = (u: { id: string; email: string }): User => ({ id: u.id, email: u.email }) as unknown as User;

/** One cron pass against the fakes, collecting its log lines. */
async function run(
  store: ReturnType<typeof fakeStore>,
  provider: ReturnType<typeof fakeProvider>,
  now: string,
  env: Record<string, string | undefined> = ENV
) {
  const lines: string[] = [];
  const result = await runDailyEmails({
    now: at(now),
    origin: ORIGIN,
    env,
    store,
    provider,
    screens: SCREENS,
    log: (line) => lines.push(line)
  });
  return { result, lines };
}

// 2026-11-18 is in Mountain Standard Time (UTC-7): 08:00 in Denver is 15:00Z.
const DENVER_8AM = "2026-11-18T15:00:00Z";

// ── 1. Opt-in only ──────────────────────────────────────────────────────────
describe("opt-in only", () => {
  it("mails nobody who has no row, and nobody whose toggle is off", async () => {
    const store = fakeStore([row(TOM, { opted_in: false })]);
    const provider = fakeProvider();
    const { result } = await run(store, provider, DENVER_8AM);
    expect(provider.sent).toHaveLength(0);
    expect(result).toMatchObject({ state: "ran", candidates: 0, sent: 0 });
  });

  it("a new person's setting reads OFF, at 8 o'clock, and reading it stores nothing", async () => {
    const store = fakeStore();
    const payload = await readPrefs(asUser(CUSTOMER), { env: ENV, store });
    expect(payload).toEqual({ available: true, prefs: { optedIn: false, hour: 8, timeZone: "", paused: false, bounced: false } });
    expect(store.rows.size).toBe(0);
  });

  it("a visit never creates a row — only turning the toggle on does", async () => {
    const store = fakeStore();
    await noteVisit(asUser(CUSTOMER), { action: "visit", dest: "study" }, { env: ENV, store, log: () => {} });
    await setPrefs(asUser(CUSTOMER), { action: "set", optedIn: false, timeZone: "America/Denver" }, { env: ENV, store, log: () => {} });
    expect(store.rows.size).toBe(0);
  });

  it("turning it on stores the browser's time zone, the hour and the language — and then they are mailed", async () => {
    const store = fakeStore();
    const provider = fakeProvider();
    const payload = await setPrefs(
      asUser(CUSTOMER),
      { action: "set", optedIn: true, hour: 8, timeZone: "America/Denver", lang: "es" },
      { env: ENV, store, now: at("2026-11-17T20:00:00Z"), log: () => {} }
    );
    expect(payload).toMatchObject({ available: true, prefs: { optedIn: true, hour: 8, timeZone: "America/Denver" } });
    expect(store.rows.get(CUSTOMER.id)).toMatchObject({ opted_in: true, time_zone: "America/Denver", send_hour: 8, lang: "es" });

    await run(store, provider, DENVER_8AM);
    expect(provider.sent.map((e) => e.to)).toEqual([CUSTOMER.email]);

    // …and turning it off stops it the next day.
    await setPrefs(asUser(CUSTOMER), { action: "set", optedIn: false }, { env: ENV, store, log: () => {} });
    await run(store, provider, "2026-11-19T15:00:00Z");
    expect(provider.sent).toHaveLength(1);
  });

  it("will not opt anyone in without a real time zone — it is never guessed", async () => {
    const store = fakeStore();
    for (const timeZone of [undefined, "", "Mars/Olympus", 7]) {
      await setPrefs(asUser(CUSTOMER), { action: "set", optedIn: true, timeZone }, { env: ENV, store, log: () => {} });
    }
    expect(store.rows.size).toBe(0);
  });

  it("the caller's row is keyed by the verified user, never by anything in the body", async () => {
    const store = fakeStore();
    await setPrefs(
      asUser(CUSTOMER),
      { action: "set", optedIn: true, timeZone: "America/Denver", user_id: TOM.id, userId: TOM.id },
      { env: ENV, store, log: () => {} }
    );
    expect([...store.rows.keys()]).toEqual([CUSTOMER.id]);
  });

  it("the real store's cron query asks for the same four conditions the fake does", () => {
    const src = readFileSync("lib/email/store.ts", "utf8");
    const list = src.slice(src.indexOf("async listSendable"), src.indexOf("async claim"));
    for (const clause of ['.eq("opted_in", true)', '.eq("paused", false)', '.eq("bounced", false)', '.is("unsubscribed_at", null)']) {
      expect(list).toContain(clause);
    }
    const claim = src.slice(src.indexOf("async claim"), src.indexOf("async release"));
    expect(claim).toContain("last_sent_day.is.null,last_sent_day.lt.");
    for (const clause of ['.eq("opted_in", true)', '.eq("bounced", false)', '.is("unsubscribed_at", null)']) {
      expect(claim).toContain(clause);
    }
  });
});

// ── 2. The audience knob ────────────────────────────────────────────────────
describe("audience knob", () => {
  it("defaults to founders; only the exact words off and all mean anything else", () => {
    expect(dailyEmailAudience(undefined)).toBe("founders");
    expect(dailyEmailAudience("")).toBe("founders");
    expect(dailyEmailAudience("founders")).toBe("founders");
    expect(dailyEmailAudience(" ALL ")).toBe("all");
    expect(dailyEmailAudience("Off")).toBe("off");
    // A typo must not email customers.
    for (const typo of ["al", "everyone", "true", "1", "on"]) expect(dailyEmailAudience(typo)).toBe("founders");
  });

  it("founders: Tom and Liz see the toggle, a customer does not", async () => {
    const env = { ...ENV, TAOS_DAILY_EMAIL: "founders" };
    const store = fakeStore();
    expect((await readPrefs(asUser(TOM), { env, store })).available).toBe(true);
    expect((await readPrefs(asUser(LIZ), { env, store })).available).toBe(true);
    expect(await readPrefs(asUser(CUSTOMER), { env, store })).toEqual({ available: false });
    // …and cannot opt in around it.
    expect(await setPrefs(asUser(CUSTOMER), { action: "set", optedIn: true, timeZone: "UTC" }, { env, store, log: () => {} })).toEqual({
      available: false
    });
    expect(store.rows.size).toBe(0);
  });

  it("off: nobody sees the toggle, and the cron sends nothing and touches nothing", async () => {
    const env = { ...ENV, TAOS_DAILY_EMAIL: "off" };
    const store = fakeStore([row(TOM)]);
    const provider = fakeProvider();
    expect(await readPrefs(asUser(TOM), { env, store })).toEqual({ available: false });
    const { result, lines } = await run(store, provider, DENVER_8AM, env);
    expect(result.state).toBe("off");
    expect(provider.sent).toHaveLength(0);
    expect(store.calls).toEqual([]);
    expect(lines).toEqual(["[taos-daily-email] run state=off"]);
  });

  it("is re-checked at SEND time: narrowing all → founders stops a customer who already opted in", async () => {
    const store = fakeStore([row(TOM), row(CUSTOMER)]);
    const provider = fakeProvider();
    const { result } = await run(store, provider, DENVER_8AM, { ...ENV, TAOS_DAILY_EMAIL: "founders" });
    expect(provider.sent.map((e) => e.to)).toEqual([TOM.email]);
    expect(result).toMatchObject({ sent: 1, skipped: 1 });
    // The customer's day was not spent: widening the knob again reaches them.
    expect(store.rows.get(CUSTOMER.id)?.last_sent_day).toBeNull();
  });

  it("the shared-passcode account is never offered the toggle and never mailed, under any setting", async () => {
    expect(readFileSync("components/SignIn.tsx", "utf8")).toContain(`const SHARED_EMAIL = "${SHARED_ACCOUNT_EMAIL}"`);
    for (const mode of ["founders", "all"] as const) {
      expect(audienceAllows(mode, SHARED_ACCOUNT_EMAIL)).toBe(false);
      expect(audienceAllows(mode, ` ${SHARED_ACCOUNT_EMAIL.toUpperCase()} `)).toBe(false);
    }
    const shared = { id: "44444444-4444-4444-8444-444444444444", email: SHARED_ACCOUNT_EMAIL };
    const store = fakeStore([row(shared)], [shared]);
    const provider = fakeProvider();
    await run(store, provider, DENVER_8AM);
    expect(provider.sent).toHaveLength(0);
  });
});

// ── 3. Their own clock ──────────────────────────────────────────────────────
describe("time-zone matching", () => {
  it("reads the wall clock in the person's zone", () => {
    expect(localMoment(at("2026-11-18T15:00:00Z"), "America/Denver")).toEqual({ day: "2026-11-18", hour: 8 });
    expect(localMoment(at("2026-11-18T07:00:00Z"), "Europe/Madrid")).toEqual({ day: "2026-11-18", hour: 8 });
    // Still yesterday in Denver, already tomorrow in Tokyo.
    expect(localMoment(at("2026-11-18T03:30:00Z"), "America/Denver")).toEqual({ day: "2026-11-17", hour: 20 });
    expect(localMoment(at("2026-11-18T23:00:00Z"), "Asia/Tokyo")).toEqual({ day: "2026-11-19", hour: 8 });
    // Midnight is hour 0, not 24.
    expect(localMoment(at("2026-11-18T07:00:00Z"), "America/Denver").hour).toBe(0);
    // A zone nobody has heard of reads as UTC rather than throwing in the cron.
    expect(localMoment(at("2026-11-18T15:00:00Z"), "Mars/Olympus")).toEqual({ day: "2026-11-18", hour: 15 });
    expect(isValidTimeZone("America/Denver")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("one UTC hour is 8 o'clock for some people and not for others", async () => {
    const store = fakeStore([
      row(TOM, { time_zone: "America/Denver" }),
      row(LIZ, { time_zone: "Europe/Madrid" }),
      row(CUSTOMER, { time_zone: "Asia/Tokyo" })
    ]);
    const provider = fakeProvider();
    await run(store, provider, "2026-11-18T07:00:00Z"); // 08:00 Madrid, 00:00 Denver, 16:00 Tokyo
    expect(provider.sent.map((e) => e.to)).toEqual([LIZ.email]);
    await run(store, provider, DENVER_8AM); // 08:00 Denver, 16:00 Madrid
    expect(provider.sent.map((e) => e.to)).toEqual([LIZ.email, TOM.email]);
    await run(store, provider, "2026-11-18T23:00:00Z"); // 08:00 Tokyo, the 19th there
    expect(provider.sent.map((e) => e.to)).toEqual([LIZ.email, TOM.email, CUSTOMER.email]);
    expect(store.rows.get(CUSTOMER.id)?.last_sent_day).toBe("2026-11-19");
  });

  it("someone who opts in at 3 pm hears nothing until tomorrow morning", () => {
    expect(isDue({ day: "2026-11-18", hour: 15 }, { send_hour: 8, last_sent_day: null })).toBe(false);
    expect(isDue({ day: "2026-11-18", hour: 7 }, { send_hour: 8, last_sent_day: null })).toBe(false);
    expect(isDue({ day: "2026-11-19", hour: 8 }, { send_hour: 8, last_sent_day: null })).toBe(true);
  });

  /** Walk the hourly cron across a span and report the UTC instants that sent. */
  async function walk(store: ReturnType<typeof fakeStore>, fromIso: string, hours: number): Promise<string[]> {
    const provider = fakeProvider();
    const sentAt: string[] = [];
    for (let h = 0; h < hours; h += 1) {
      const now = new Date(at(fromIso).getTime() + h * 3_600_000).toISOString();
      const before = provider.sent.length;
      await run(store, provider, now);
      if (provider.sent.length > before) sentAt.push(now);
    }
    return sentAt;
  }

  it("SPRING FORWARD (Denver, 2026-03-08): 02:00 does not exist — an hour-2 person is mailed at 03:00, once", async () => {
    // 01:00 MST = 08:00Z; the next hour, 09:00Z, is 03:00 MDT. There is no 02:00.
    expect(localMoment(at("2026-03-08T08:00:00Z"), "America/Denver").hour).toBe(1);
    expect(localMoment(at("2026-03-08T09:00:00Z"), "America/Denver").hour).toBe(3);
    const store = fakeStore([row(TOM, { send_hour: 2 })]);
    // Start at 06:00 local on the 7th — past that day's window — and walk two days.
    const sentAt = await walk(store, "2026-03-07T13:00:00Z", 48);
    // The 8th at 03:00 MDT (the window catches the missing hour); the 9th at 02:00 MDT.
    expect(sentAt).toEqual(["2026-03-08T09:00:00.000Z", "2026-03-09T08:00:00.000Z"]);
  });

  it("SPRING FORWARD: an 8 o'clock person still gets 8 o'clock — an hour earlier in UTC than the day before", async () => {
    const store = fakeStore([row(TOM)]);
    const sentAt = await walk(store, "2026-03-07T00:00:00Z", 72);
    expect(sentAt).toEqual(["2026-03-07T15:00:00.000Z", "2026-03-08T14:00:00.000Z", "2026-03-09T14:00:00.000Z"]);
  });

  it("FALL BACK (Denver, 2026-11-01): 01:00 happens twice — an hour-1 person is mailed the first time only", async () => {
    expect(localMoment(at("2026-11-01T07:00:00Z"), "America/Denver")).toEqual({ day: "2026-11-01", hour: 1 }); // MDT
    expect(localMoment(at("2026-11-01T08:00:00Z"), "America/Denver")).toEqual({ day: "2026-11-01", hour: 1 }); // MST
    const store = fakeStore([row(TOM, { send_hour: 1 })]);
    const sentAt = await walk(store, "2026-10-31T00:00:00Z", 72);
    expect(sentAt).toEqual(["2026-10-31T07:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"]);
  });

  it("across a whole year of hourly crons, a person gets exactly one email per local day", async () => {
    const store = fakeStore([row(TOM, { last_visit_at: null, opted_in_at: null })]);
    const provider = fakeProvider();
    for (let h = 0; h < 365 * 24; h += 1) {
      await run(store, provider, new Date(Date.UTC(2026, 0, 1) + h * 3_600_000).toISOString());
    }
    const days = provider.sent.map((e) => e.idempotencyKey);
    expect(new Set(days).size).toBe(days.length);
    expect(days.length).toBe(365); // every Denver day of 2026 that has an 08:00 inside the span
  });
});

// ── 4. Once a day ───────────────────────────────────────────────────────────
describe("idempotency", () => {
  it("the cron firing twice in the same hour sends once", async () => {
    const store = fakeStore([row(TOM)]);
    const provider = fakeProvider();
    await run(store, provider, DENVER_8AM);
    const second = await run(store, provider, "2026-11-18T15:00:40Z");
    expect(provider.sent).toHaveLength(1);
    expect(second.result).toMatchObject({ due: 0, sent: 0 });
  });

  it("two crons at the SAME moment send once — only the run that moves the day stamp sends", async () => {
    const store = fakeStore([row(TOM), row(LIZ)]);
    const provider = fakeProvider();
    const [a, b] = await Promise.all([run(store, provider, DENVER_8AM), run(store, provider, DENVER_8AM)]);
    expect(provider.sent.map((e) => e.to).sort()).toEqual([LIZ.email, TOM.email].sort());
    expect(a.result.sent + b.result.sent).toBe(2);
  });

  it("a skipped hour is caught by the next run, inside a three-hour window — and not after it", async () => {
    const caught = fakeStore([row(TOM)]);
    const provider = fakeProvider();
    await run(caught, provider, "2026-11-18T18:00:00Z"); // 11:00 local, 8 + 3
    expect(provider.sent).toHaveLength(1);

    const late = fakeStore([row(TOM)]);
    await run(late, provider, "2026-11-18T19:00:00Z"); // 12:00 local — too late to call it a morning reminder
    expect(provider.sent).toHaveLength(1);
    expect(late.rows.get(TOM.id)?.last_sent_day).toBeNull();
  });

  it("a failed send lets go of the day, so the next hour tries again — and still only one arrives", async () => {
    const store = fakeStore([row(TOM, { last_sent_day: "2026-11-17" })]);
    const provider = fakeProvider();
    provider.queue.push({ ok: false, status: 503, retryable: true });
    const first = await run(store, provider, DENVER_8AM);
    expect(first.result).toMatchObject({ failed: 1, sent: 0 });
    expect(store.rows.get(TOM.id)?.last_sent_day).toBe("2026-11-17");

    await run(store, provider, "2026-11-18T16:00:00Z");
    expect(provider.sent).toHaveLength(1);
    expect(store.rows.get(TOM.id)?.last_sent_day).toBe("2026-11-18");
  });

  it("the provider is given the same idempotency key for the same person and local day", async () => {
    const store = fakeStore([row(TOM, { last_sent_day: "2026-11-17" })]);
    const provider = fakeProvider();
    await run(store, provider, DENVER_8AM);
    store.rows.get(TOM.id)!.last_sent_day = "2026-11-17"; // as if the stamp were lost
    await run(store, provider, "2026-11-18T16:00:00Z");
    expect(provider.sent.map((e) => e.idempotencyKey)).toEqual([
      `taos-daily-${TOM.id}-2026-11-18`,
      `taos-daily-${TOM.id}-2026-11-18`
    ]);
  });

  it("a 409 from the provider means it already has today's email: the day stays spent", async () => {
    const store = fakeStore([row(TOM)]);
    const provider = fakeProvider();
    provider.queue.push({ ok: false, status: 409, retryable: false });
    const { result } = await run(store, provider, DENVER_8AM);
    expect(result).toMatchObject({ failed: 0, skipped: 1 });
    expect(store.rows.get(TOM.id)?.last_sent_day).toBe("2026-11-18");
  });
});

// ── 5. Unsubscribe ──────────────────────────────────────────────────────────
describe("unsubscribe", () => {
  const secret = ENV.TAOS_EMAIL_LINK_SECRET;

  it("the signature verifies for its own user and row, and for nothing else", () => {
    const sig = signUnsubscribe(TOM.id, "row-token", secret);
    expect(verifyUnsubscribe(TOM.id, "row-token", secret, sig)).toBe(true);
    expect(verifyUnsubscribe(LIZ.id, "row-token", secret, sig)).toBe(false); // someone else's uuid
    expect(verifyUnsubscribe(TOM.id, "rotated", secret, sig)).toBe(false); // the row token was rotated
    expect(verifyUnsubscribe(TOM.id, "row-token", "other-secret", sig)).toBe(false);
    expect(verifyUnsubscribe(TOM.id, "row-token", secret, `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`)).toBe(false);
    for (const junk of [null, undefined, "", 7, "x".repeat(500)]) {
      expect(verifyUnsubscribe(TOM.id, "row-token", secret, junk)).toBe(false);
    }
    expect(verifyUnsubscribe(TOM.id, "row-token", "", sig)).toBe(false);
  });

  it("the link carries the uuid and the signature — never the row token, never an address", () => {
    const url = unsubscribeUrl(ORIGIN, TOM.id, "row-token", secret);
    expect(url.startsWith(`${ORIGIN}/api/email/unsubscribe?u=${TOM.id}&s=`)).toBe(true);
    expect(url).not.toContain("row-token");
    expect(url).not.toContain("@");
  });

  it("every email carries the link in its body AND the one-click headers", async () => {
    const store = fakeStore([row(TOM)]);
    const provider = fakeProvider();
    await run(store, provider, DENVER_8AM);
    const [email] = provider.sent;
    const url = unsubscribeUrl(ORIGIN, TOM.id, store.rows.get(TOM.id)!.unsubscribe_token, secret);
    expect(email.headers["List-Unsubscribe"]).toBe(`<${url}>`);
    expect(email.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(email.html).toContain(url.replace(/&/g, "&amp;"));
    expect(email.text).toContain(url);
  });

  it("once unsubscribed, the cron never mails them again — until they turn the toggle on themselves", async () => {
    const store = fakeStore([row(TOM, { last_sent_day: "2026-11-17" })]);
    const provider = fakeProvider();
    await store.unsubscribe(TOM.id);
    await run(store, provider, DENVER_8AM);
    await run(store, provider, "2026-11-19T15:00:00Z");
    expect(provider.sent).toHaveLength(0);
    expect((await readPrefs(asUser(TOM), { env: ENV, store })) as unknown).toMatchObject({ prefs: { optedIn: false } });

    await setPrefs(asUser(TOM), { action: "set", optedIn: true, timeZone: "America/Denver" }, { env: ENV, store, log: () => {} });
    expect(store.rows.get(TOM.id)).toMatchObject({ opted_in: true, unsubscribed_at: null });
    await run(store, provider, "2026-11-20T15:00:00Z");
    expect(provider.sent).toHaveLength(1);
  });

  it("the link's page unsubscribes with a POST it sends itself — a GET alone changes nothing", () => {
    const page = unsubscribePage(true);
    expect(page).toContain('fetch(location.href, { method: "POST" })');
    expect(page).toContain("<noscript>");
    expect(page).toContain(EMAIL_COPY.en.unsubDone);
    expect(page).toContain(EMAIL_COPY.es.unsubDone);
    // A bad link says so, quietly, and offers no button.
    const bad = unsubscribePage(false);
    expect(bad).toContain(EMAIL_COPY.en.unsubInvalid);
    expect(bad).not.toContain("fetch(");
    // The route: GET only ever renders the page.
    const route = readFileSync("app/api/email/unsubscribe/route.ts", "utf8");
    const get = route.slice(route.indexOf("export async function GET"));
    expect(get).not.toContain(".unsubscribe(");
  });
});

// ── 6. Don't nag ────────────────────────────────────────────────────────────
describe("auto-pause", () => {
  it(`pauses at ${PAUSE_AFTER_DAYS} days without a visit, counted from the last visit or from opting in`, () => {
    const now = at("2026-11-18T15:00:00Z");
    const daysAgo = (n: number): string => new Date(now.getTime() - n * 86_400_000).toISOString();
    expect(PAUSE_AFTER_DAYS).toBe(21);
    expect(shouldPause({ last_visit_at: daysAgo(20.9), opted_in_at: daysAgo(90) }, now)).toBe(false);
    expect(shouldPause({ last_visit_at: daysAgo(21), opted_in_at: daysAgo(90) }, now)).toBe(true);
    expect(shouldPause({ last_visit_at: null, opted_in_at: daysAgo(5) }, now)).toBe(false);
    expect(shouldPause({ last_visit_at: null, opted_in_at: daysAgo(22) }, now)).toBe(true);
    expect(shouldPause({ last_visit_at: null, opted_in_at: null }, now)).toBe(false);
  });

  it("sends ONE final 'we've paused these' email, then nothing — day after day", async () => {
    const store = fakeStore([row(TOM, { last_visit_at: "2026-10-20T15:00:00Z" })]);
    const provider = fakeProvider();
    const first = await run(store, provider, DENVER_8AM);
    expect(first.result).toMatchObject({ paused: 1, sent: 0 });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].subject).toBe(EMAIL_COPY.en.pausedSubject);
    expect(provider.sent[0].html).toContain(EMAIL_COPY.en.pausedButton);
    expect(provider.sent[0].tags.kind).toBe("paused");
    expect(store.rows.get(TOM.id)?.paused).toBe(true);

    for (let d = 1; d <= 10; d += 1) {
      await run(store, provider, new Date(at(DENVER_8AM).getTime() + d * 86_400_000).toISOString());
    }
    expect(provider.sent).toHaveLength(1);
  });

  it("the day before, it is still the ordinary daily email", async () => {
    const store = fakeStore([row(TOM, { last_visit_at: "2026-10-29T15:00:00Z" })]); // 20 days
    const provider = fakeProvider();
    await run(store, provider, DENVER_8AM);
    expect(provider.sent[0].tags.kind).toBe("daily");
    expect(store.rows.get(TOM.id)?.paused).toBe(false);
  });

  it("a failed 'paused' email does not leave them paused without ever being told", async () => {
    const store = fakeStore([row(TOM, { last_visit_at: "2026-10-20T15:00:00Z" })]);
    const provider = fakeProvider();
    provider.queue.push({ ok: false, status: 500, retryable: true });
    await run(store, provider, DENVER_8AM);
    expect(store.rows.get(TOM.id)).toMatchObject({ paused: false, last_sent_day: null });
    await run(store, provider, "2026-11-18T16:00:00Z");
    expect(provider.sent).toHaveLength(1);
    expect(store.rows.get(TOM.id)?.paused).toBe(true);
  });

  it("coming back to /study or /tutor resumes them, and restarts the 21 days", async () => {
    const store = fakeStore([row(TOM, { last_visit_at: "2026-10-20T15:00:00Z" })]);
    const provider = fakeProvider();
    await run(store, provider, DENVER_8AM);
    expect(store.rows.get(TOM.id)?.paused).toBe(true);

    const back = await noteVisit(asUser(TOM), { action: "visit", dest: "tutor" }, { env: ENV, store, now: at("2026-11-25T01:00:00Z"), log: () => {} });
    expect(back).toMatchObject({ available: true, prefs: { optedIn: true, paused: false } });
    await run(store, provider, "2026-11-25T15:00:00Z");
    expect(provider.sent).toHaveLength(2);
    expect(provider.sent[1].tags.kind).toBe("daily");
  });

  it("the streak line is a count of visit days in the last seven, and nothing more", () => {
    expect(withVisit(["2026-11-10", "2026-11-12", "2026-11-17"], "2026-11-18")).toEqual(["2026-11-12", "2026-11-17", "2026-11-18"]);
    expect(withVisit(["2026-11-18"], "2026-11-18")).toEqual(["2026-11-18"]);
    expect(daysThisWeek(["2026-11-11", "2026-11-12", "2026-11-17", "2026-11-18"], "2026-11-18")).toBe(3);
    expect(daysThisWeek(null, "2026-11-18")).toBe(0);
  });
});

describe("bounces and complaints", () => {
  const secret = `whsec_${Buffer.from("webhook-signing-key").toString("base64")}`;
  const body = JSON.stringify({
    type: "email.bounced",
    created_at: "2026-11-18T15:00:05Z",
    data: {
      email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
      to: ["someone@example.test"],
      bounce: { type: "Permanent", subType: "Suppressed", message: "…" },
      tags: { uid: TOM.id, kind: "daily" }
    }
  });
  const now = at("2026-11-18T15:00:10Z");
  const ts = String(Math.floor(now.getTime() / 1000));

  it("accepts only a correctly signed, recent request", () => {
    const signature = `v1,${signWebhook(secret, "msg_1", ts, body)}`;
    const good = { secret, id: "msg_1", timestamp: ts, signature, body, now };
    expect(verifyWebhook(good)).toBe(true);
    // Several signatures may be listed (key rotation): any one matching is enough.
    expect(verifyWebhook({ ...good, signature: `v1,AAAA ${signature}` })).toBe(true);
    expect(verifyWebhook({ ...good, body: body.replace(TOM.id, LIZ.id) })).toBe(false); // body changed
    expect(verifyWebhook({ ...good, id: "msg_2" })).toBe(false);
    expect(verifyWebhook({ ...good, secret: `whsec_${Buffer.from("another-key").toString("base64")}` })).toBe(false);
    expect(verifyWebhook({ ...good, signature: null })).toBe(false);
    expect(verifyWebhook({ ...good, signature: signature.replace("v1,", "v2,") })).toBe(false);
    // Replayed six minutes later.
    expect(verifyWebhook({ ...good, now: new Date(now.getTime() + 6 * 60_000) })).toBe(false);
    expect(verifyWebhook({ ...good, secret: "" })).toBe(false);
  });

  it("reads the user from the uid tag (either shape) or falls back to the provider's email id — never the address", () => {
    expect(parseDeliveryEvent(JSON.parse(body))).toEqual({
      kind: "bounce",
      userId: TOM.id,
      messageId: "56761188-7520-42d8-8898-ff6fc54ce618"
    });
    expect(parseDeliveryEvent({ type: "email.complained", data: { email_id: "e1", tags: [{ name: "uid", value: LIZ.id }] } })).toEqual({
      kind: "complaint",
      userId: LIZ.id,
      messageId: "e1"
    });
    expect(parseDeliveryEvent({ type: "email.bounced", data: { email_id: "e2", tags: { uid: "not-a-uuid" } } })).toEqual({
      kind: "bounce",
      userId: null,
      messageId: "e2"
    });
    for (const other of ["email.sent", "email.delivered", "email.opened", "email.clicked"]) {
      expect(parseDeliveryEvent({ type: other, data: { tags: { uid: TOM.id } } })).toBeNull();
    }
    expect(parseDeliveryEvent(null)).toBeNull();
    const src = readFileSync("lib/email/webhook.ts", "utf8") + readFileSync("app/api/email/webhook/route.ts", "utf8");
    expect(src).not.toMatch(/data\.to\b|\.to\[/);
  });

  it("a bounced address is never mailed again, and the toggle cannot turn it back on", async () => {
    const store = fakeStore([row(TOM, { last_message_id: "e9" })]);
    const provider = fakeProvider();
    expect(await store.userForMessage("e9")).toBe(TOM.id);
    await store.flagBounce(TOM.id);

    await run(store, provider, DENVER_8AM);
    expect(provider.sent).toHaveLength(0);

    const again = await setPrefs(asUser(TOM), { action: "set", optedIn: true, timeZone: "America/Denver" }, { env: ENV, store, log: () => {} });
    expect(again).toMatchObject({ available: true, prefs: { optedIn: false, bounced: true } });
    await run(store, provider, "2026-11-19T15:00:00Z");
    expect(provider.sent).toHaveLength(0);
  });

  it("a bounce that lands between the list and the send still stops the send (the claim re-checks)", async () => {
    const store = fakeStore([row(TOM)]);
    const provider = fakeProvider();
    const list = store.listSendable.bind(store);
    store.listSendable = async (limit) => {
      const rows = await list(limit);
      await store.flagBounce(TOM.id);
      return rows;
    };
    const { result } = await run(store, provider, DENVER_8AM);
    expect(provider.sent).toHaveLength(0);
    expect(result).toMatchObject({ due: 1, skipped: 1 });
  });
});

// ── 7. Inert without keys ───────────────────────────────────────────────────
describe("missing-key inertness", () => {
  it("names exactly the four things a send needs", () => {
    expect([...REQUIRED_ENV]).toEqual(["RESEND_API_KEY", "TAOS_EMAIL_FROM", "TAOS_EMAIL_FOOTER_ADDRESS", "TAOS_EMAIL_LINK_SECRET"]);
    expect(missingEmailEnv(ENV)).toEqual([]);
    expect(missingEmailEnv({})).toEqual([...REQUIRED_ENV]);
    expect(missingEmailEnv({ ...ENV, RESEND_API_KEY: "   " })).toEqual(["RESEND_API_KEY"]);
  });

  for (const name of REQUIRED_ENV) {
    it(`without ${name}: one log line naming it, no send, no table read, no toggle, no throw`, async () => {
      const env = { ...ENV, [name]: undefined };
      const store = fakeStore([row(TOM)]);
      const provider = fakeProvider();
      const { result, lines } = await run(store, provider, DENVER_8AM, env);
      expect(result.state).toBe("inert");
      expect(lines).toEqual([`[taos-daily-email] run state=inert missing=${name}`]);
      expect(provider.sent).toHaveLength(0);
      expect(store.calls).toEqual([]);
      expect(await readPrefs(asUser(TOM), { env, store })).toEqual({ available: false });
      expect(await setPrefs(asUser(TOM), { action: "set", optedIn: false }, { env, store, log: () => {} })).toEqual({ available: false });
    });
  }

  it("the inert line names variables, never their values", async () => {
    const env = { ...ENV, TAOS_EMAIL_FOOTER_ADDRESS: "" };
    const { lines } = await run(fakeStore([row(TOM)]), fakeProvider(), DENVER_8AM, env);
    for (const value of [ENV.RESEND_API_KEY, ENV.TAOS_EMAIL_LINK_SECRET, ENV.TAOS_EMAIL_FROM]) {
      expect(lines.join("\n")).not.toContain(value);
    }
  });

  it("no footer address is ever invented: the source has no fallback for it", () => {
    const src = readFileSync("lib/email/config.ts", "utf8");
    expect(src).toMatch(/footerAddress: \(env\.TAOS_EMAIL_FOOTER_ADDRESS \?\? ""\)\.trim\(\)/);
    expect(src.match(/TAOS_EMAIL_FOOTER_ADDRESS/g)?.length).toBe(2); // the required list, and the read
  });

  it("before the migration is applied: no toggle, the cron says no_table, nothing throws", async () => {
    const store = fakeStore([row(TOM)]);
    store.missing = true;
    const provider = fakeProvider();
    expect(await readPrefs(asUser(TOM), { env: ENV, store })).toEqual({ available: false });
    expect(await noteVisit(asUser(TOM), { action: "visit", dest: "study" }, { env: ENV, store, log: () => {} })).toEqual({ available: false });
    expect(await setPrefs(asUser(TOM), { action: "set", optedIn: true, timeZone: "UTC" }, { env: ENV, store, log: () => {} })).toEqual({
      available: false
    });
    const { result, lines } = await run(store, provider, DENVER_8AM);
    expect(result.state).toBe("no_table");
    expect(lines).toEqual(["[taos-daily-email] run state=no_table"]);
    expect(provider.sent).toHaveLength(0);
  });
});

// ── 8. No conversation text ─────────────────────────────────────────────────
describe("what is in the email", () => {
  const fold = (s: string): string =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[¿¡]/g, "")
      .trim();

  function coursePairs(): Set<string> {
    const pairs = new Set<string>();
    const root = "content/tutor-course";
    const files = [
      ...readdirSync(root).filter((f) => /^\d\d-day-/.test(f)).map((f) => join(root, f)),
      ...readdirSync(join(root, "week-02")).map((f) => join(root, "week-02", f))
    ];
    for (const file of files) {
      const md = readFileSync(file, "utf8");
      const start = md.indexOf("## Micro-Sentences");
      if (start === -1) continue;
      const rest = md.slice(start + 3);
      const end = rest.indexOf("\n## ");
      for (const line of (end === -1 ? rest : rest.slice(0, end)).split("\n")) {
        const cells = line.split("|").map((c) => c.trim());
        if (cells.length >= 4 && cells[1] && cells[2]) pairs.add(`${cells[1]}|${fold(cells[2])}`);
      }
    }
    return pairs;
  }

  it("every phrase of the day is a line from the built-in course — both halves of it", () => {
    const course = coursePairs();
    expect(course.size).toBeGreaterThan(100);
    expect(DAILY_PHRASES).toHaveLength(28);
    for (const p of DAILY_PHRASES) {
      expect(course.has(`${p.en}|${fold(p.es)}`), `${p.en} / ${p.es}`).toBe(true);
    }
    expect(new Set(DAILY_PHRASES.map((p) => p.en)).size).toBe(DAILY_PHRASES.length);
  });

  it("everyone gets the same phrase on the same day, and it changes daily", () => {
    expect(phraseForDay("2026-11-18")).toBe(phraseForDay("2026-11-18"));
    expect(phraseForDay("2026-11-18")).not.toBe(phraseForDay("2026-11-19"));
    const month = new Set(Array.from({ length: 28 }, (_, i) => phraseForDay(`2026-11-${String(i + 1).padStart(2, "0")}`)));
    expect(month.size).toBe(28);
  });

  it("nothing under lib/email or app/api/email reads a text column of anybody's conversations", () => {
    const files = [
      ...readdirSync("lib/email").map((f) => join("lib/email", f)),
      ...readdirSync("app/api/email").map((d) => join("app/api/email", d, "route.ts")),
      "components/DailyReminder.tsx"
    ];
    expect(files.length).toBeGreaterThan(12);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const column of ["original_text", "translated_text", "heard_text", "translation,", "transcript"]) {
        expect(src, `${file} mentions ${column}`).not.toContain(column);
      }
    }
    // The one read of the translations table is a count with no rows in it.
    const store = readFileSync("lib/email/store.ts", "utf8");
    expect(store.match(/TRANSLATIONS_TABLE\)/g)).toHaveLength(1);
    expect(store).toContain('.select("id", { count: "exact", head: true })');
  });

  it("a user with conversations is sent to /study, one without to /tutor — and the row's own words never travel", async () => {
    const store = fakeStore([row(TOM), row(LIZ, { lang: "es" })]);
    store.conversations.add(TOM.id);
    const provider = fakeProvider();
    await run(store, provider, DENVER_8AM);
    const tom = provider.sent.find((e) => e.to === TOM.email)!;
    const liz = provider.sent.find((e) => e.to === LIZ.email)!;
    expect(tom.html).toContain(`${ORIGIN}/study?src=daily-email`);
    expect(tom.html).toContain(EMAIL_COPY.en.buttonStudy);
    expect(liz.html).toContain(`${ORIGIN}/tutor?src=daily-email`);
    expect(liz.html).toContain(EMAIL_COPY.es.buttonTutor);
  });

  const base = {
    kind: "daily" as const,
    phrase: { en: "Where is the bathroom?", es: "¿Dónde está el baño?" },
    daysThisWeek: 3,
    destination: "study" as const,
    origin: ORIGIN,
    unsubscribeUrl: `${ORIGIN}/api/email/unsubscribe?u=${TOM.id}&s=sig`,
    footerAddress: ENV.TAOS_EMAIL_FOOTER_ADDRESS
  };

  it("ENGLISH reader: the Spanish phrase, its meaning in English, one button, the footer", () => {
    const email = renderEmail({ ...base, lang: "en" });
    expect(email.subject).toBe("Today's phrase: ¿Dónde está el baño?");
    expect(email.html).toContain('<html lang="en">');
    expect(email.html).toContain('<p lang="es"');
    expect(email.html).toContain("¿Dónde está el baño?");
    expect(email.html).toContain("It means: <span");
    expect(email.html).toContain("Where is the bathroom?");
    expect(email.html).toContain("You practiced 3 days this week.");
    expect(email.html).toContain(ENV.TAOS_EMAIL_FOOTER_ADDRESS);
    expect(email.html).toContain("Unsubscribe");
    expect(email.html.match(/<a /g)).toHaveLength(2); // the button, and unsubscribe
    expect(email.html).not.toMatch(/<img|<script|<link/); // nothing remote, nothing that tracks an open
    expect(email.text).toContain(`Open Study: ${ORIGIN}/study?src=daily-email`);
    expect(email.text).toContain(ENV.TAOS_EMAIL_FOOTER_ADDRESS);
  });

  it("SPANISH reader: the English phrase, its meaning in Spanish, everything else in Spanish", () => {
    const email = renderEmail({ ...base, lang: "es", daysThisWeek: 1, destination: "tutor" });
    expect(email.subject).toBe("La frase de hoy: Where is the bathroom?");
    expect(email.html).toContain('<html lang="es">');
    expect(email.html).toContain('<p lang="en"');
    expect(email.html).toContain("Significa: <span");
    expect(email.html).toContain("Abrir Tutor");
    expect(email.html).toContain("Practicaste 1 día esta semana.");
    expect(email.html).toContain("Cancelar suscripción");
    expect(email.html).not.toContain("Open Study");
    expect(email.html).not.toContain("Unsubscribe<");
  });

  it("renders all four emails to HTML files (the PR's screenshots are taken from these)", () => {
    // $TMPDIR/taos-daily-email/{daily,paused}-{en,es}.html — open one in a
    // browser to see exactly what would be sent. The address is a stand-in.
    const dir = join(tmpdir(), "taos-daily-email");
    mkdirSync(dir, { recursive: true });
    for (const kind of ["daily", "paused"] as const) {
      for (const lang of ["en", "es"] as const) {
        const email = renderEmail({ ...base, kind, lang, footerAddress: "[TAOS_EMAIL_FOOTER_ADDRESS — Tom's mailing address goes here]" });
        expect(email.html.startsWith("<!doctype html>")).toBe(true);
        expect(email.html).toContain(`<html lang="${lang}">`);
        writeFileSync(join(dir, `${kind}-${lang}.html`), email.html);
      }
    }
    expect(readdirSync(dir).filter((f) => f.endsWith(".html")).length).toBeGreaterThanOrEqual(4);
  });

  it("no streak line when there is nothing to count; the address is escaped, not trusted", () => {
    const email = renderEmail({ ...base, lang: "en", daysThisWeek: 0, footerAddress: 'Blackbird <b>LLC</b> & Co, "Taos"' });
    expect(email.html).not.toContain("this week");
    expect(email.html).toContain("Blackbird &lt;b&gt;LLC&lt;/b&gt; &amp; Co, &quot;Taos&quot;");
  });

  it("the language follows the person's own side of the pair; anything but Spanish reads English for now", () => {
    expect(emailLang("es")).toBe("es");
    expect(emailLang("es-MX")).toBe("es");
    for (const other of ["en", "it", "ja", "", null, undefined]) expect(emailLang(other)).toBe("en");
  });

  it("the two copy tables have the same keys, and every Spanish line is marked for Liz", () => {
    expect(Object.keys(EMAIL_COPY.es).sort()).toEqual(Object.keys(EMAIL_COPY.en).sort());
    for (const value of [...Object.values(EMAIL_COPY.en), ...Object.values(EMAIL_COPY.es)]) {
      expect(value.trim()).not.toBe("");
      expect(value).not.toContain("!");
    }
    const src = readFileSync("lib/email/copy.ts", "utf8");
    const es = src.slice(src.indexOf("const ES: EmailCopy"), src.indexOf("export const EMAIL_COPY"));
    const marks = es.match(/pendiente de revisión por Liz/g) ?? [];
    expect(marks.length).toBe(Object.keys(EMAIL_COPY.es).length);
  });
});

// ── 9. Logs are fields ──────────────────────────────────────────────────────
describe("logs", () => {
  it("carry counts, a uuid and an outcome — never an address, a subject or a phrase", async () => {
    const store = fakeStore([row(TOM), row(LIZ, { lang: "es", last_visit_at: "2026-10-01T00:00:00Z" }), row(CUSTOMER)]);
    const provider = fakeProvider();
    provider.queue.push({ ok: false, status: 500, retryable: true });
    const lines: string[] = [];
    const log = (line: string): void => void lines.push(line);
    await runDailyEmails({ now: at(DENVER_8AM), origin: ORIGIN, env: ENV, store, provider, screens: SCREENS, log });
    await noteVisit(asUser(TOM), { action: "visit", dest: "study", src: "daily-email" }, { env: ENV, store, log });
    await setPrefs(asUser(TOM), { action: "set", optedIn: false }, { env: ENV, store, log });

    expect(lines.length).toBeGreaterThanOrEqual(6);
    const all = lines.join("\n");
    expect(all).not.toContain("@");
    for (const p of DAILY_PHRASES) {
      expect(all).not.toContain(p.en);
      expect(all).not.toContain(p.es);
    }
    for (const line of lines) expect(line.startsWith("[taos-daily-email] ")).toBe(true);
    expect(lines).toContain(`[taos-daily-email] open user=${TOM.id} dest=study src=daily-email`);
    expect(lines.filter((l) => l.includes(" open "))).toHaveLength(1);
    expect(all).toMatch(/run state=ran audience=all candidates=3 due=3 sent=1 paused=1 failed=1 skipped=0/);
  });

  it("an open is counted only when the visit carries the email's marker", async () => {
    const store = fakeStore([row(TOM)]);
    const lines: string[] = [];
    await noteVisit(asUser(TOM), { action: "visit", dest: "study" }, { env: ENV, store, log: (l) => lines.push(l) });
    await noteVisit(asUser(TOM), { action: "visit", dest: "study", src: "newsletter" }, { env: ENV, store, log: (l) => lines.push(l) });
    expect(lines).toEqual([]);
    // No destination, no visit.
    expect(await noteVisit(asUser(TOM), { action: "visit", dest: "call" }, { env: ENV, store, log: () => {} })).toEqual({ available: false });
  });

  it("no file in the feature has a console call that could print an address", () => {
    for (const file of ["lib/email/provider.ts", "lib/email/render.ts", "lib/email/store.ts", "lib/email/webhook.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/console\.(log|warn|error|info)/);
    }
  });
});

// ── The provider, the cron wiring, the migration ───────────────────────────
describe("the Resend provider", () => {
  const email = {
    from: ENV.TAOS_EMAIL_FROM,
    to: TOM.email,
    subject: "s",
    html: "<p>h</p>",
    text: "t",
    headers: { "List-Unsubscribe": "<https://x.test/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    tags: { uid: TOM.id, kind: "daily" },
    idempotencyKey: "taos-daily-x-2026-11-18"
  };

  it("is one POST: bearer key, idempotency key, headers and tags in Resend's shape", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "49a3999c" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await resendProvider("re_key", fetcher).send(email);
    expect(result).toEqual({ ok: true, id: "49a3999c" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_key");
    expect(headers["Idempotency-Key"]).toBe("taos-daily-x-2026-11-18");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      from: email.from,
      to: [TOM.email],
      subject: "s",
      html: "<p>h</p>",
      text: "t",
      headers: email.headers,
      tags: [
        { name: "uid", value: TOM.id },
        { name: "kind", value: "daily" }
      ]
    });
  });

  it("turns a refusal or a dead network into a result, never a throw", async () => {
    const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;
    expect(await resendProvider("k", status(429)).send(email)).toEqual({ ok: false, status: 429, retryable: true });
    expect(await resendProvider("k", status(500)).send(email)).toEqual({ ok: false, status: 500, retryable: true });
    expect(await resendProvider("k", status(422)).send(email)).toEqual({ ok: false, status: 422, retryable: false });
    const dead = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await resendProvider("k", dead).send(email)).toEqual({ ok: false, status: 0, retryable: true });
  });
});

describe("wiring", () => {
  it("vercel.json runs the pass every hour, and keeps the two daily crons it had", () => {
    const { crons } = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(crons).toContainEqual({ path: "/api/email/daily", schedule: "0 * * * *" });
    expect(crons).toContainEqual({ path: "/api/predict/rebuild", schedule: "0 8 * * *" });
    expect(crons).toContainEqual({ path: "/api/walkie/sweep", schedule: "30 8 * * *" });
  });

  it("the cron route does not run without CRON_SECRET, and has no by-hand path", () => {
    const src = readFileSync("app/api/email/daily/route.ts", "utf8");
    expect(src).toContain("if (!secret || header !== `Bearer ${secret}`)");
    expect(src).not.toContain("getUserFromRequest");
    expect(src).not.toContain("export async function POST");
  });

  it("the migration: RLS on, own-row select and update only, and the bookkeeping columns fenced off", () => {
    const sql = readFileSync("supabase/migrations/20261118_daily_email_prefs.sql", "utf8");
    expect(sql).toContain("alter table public.daily_email_prefs enable row level security;");
    expect(sql.match(/create policy/g)).toHaveLength(2);
    expect(sql).toMatch(/for select to authenticated\s+using \(auth\.uid\(\) = user_id\)/);
    expect(sql).toMatch(/for update to authenticated\s+using \(auth\.uid\(\) = user_id\)\s+with check \(auth\.uid\(\) = user_id\)/);
    expect(sql).not.toMatch(/for (insert|delete|all)/);
    expect(sql).toContain("grant update (opted_in, time_zone, send_hour, lang) on public.daily_email_prefs to authenticated;");
    expect(sql).toContain("opted_in          boolean not null default false");
    expect(sql).toContain("references auth.users (id) on delete cascade");
    // Every column the code reads exists in the file.
    for (const column of Object.keys(row(TOM))) expect(sql, column).toMatch(new RegExp(`\\n  ${column}\\s`));
  });

  it("/tutor comes back to /tutor after sign-in, as /study already did", () => {
    expect(readFileSync("components/TutorShell.tsx", "utf8")).toContain('<SignIn redirectPath="/tutor" />');
    expect(readFileSync("components/StudyShell.tsx", "utf8")).toContain('redirectPath="/study"');
  });
});
