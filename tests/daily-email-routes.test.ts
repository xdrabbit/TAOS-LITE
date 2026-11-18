// The daily reminder's four routes, with the REAL handlers running.
//
// tests/daily-email.test.ts pins the rules against the functions; this file
// pins the doors: who may knock on each route, and what happens when they do.
// Faked: the session (lib/authServer) and the table (lib/email/store's
// exported store is swapped for the in-memory one). Nothing here can reach a
// provider — the only send path is the cron, and it is exercised inert.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { signUnsubscribe } from "@/lib/email/token";
import { signWebhook } from "@/lib/email/webhook";
import { ENV, fakeStore, row, TOM, type FakeStore } from "./helpers/dailyEmailFakes";

let store: FakeStore;
vi.mock("@/lib/email/store", () => ({
  PREFS_TABLE: "daily_email_prefs",
  get supabasePrefsStore() {
    return store;
  }
}));

let caller: { id: string; email: string } | null = null;
vi.mock("@/lib/authServer", () => ({ getUserFromRequest: async () => caller }));

const ALL = ["CRON_SECRET", "RESEND_WEBHOOK_SECRET", ...Object.keys(ENV)];
let logs: string[] = [];

beforeEach(() => {
  store = fakeStore([row(TOM)]);
  caller = null;
  logs = [];
  for (const name of ALL) vi.stubEnv(name, "");
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void logs.push(String(line)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setEnv(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

describe("GET /api/email/daily (the cron)", () => {
  const call = async (auth?: string) => {
    const { GET } = await import("@/app/api/email/daily/route");
    return GET(new NextRequest("https://taoslite.com/api/email/daily", { headers: auth ? { authorization: auth } : {} }));
  };

  it("does not exist for anyone without the cron secret — and not at all when no secret is set", async () => {
    expect((await call()).status).toBe(404);
    expect((await call("Bearer ")).status).toBe(404); // CRON_SECRET unset: an empty bearer must not match
    setEnv({ CRON_SECRET: "cron-secret" });
    expect((await call()).status).toBe(404);
    expect((await call("Bearer wrong")).status).toBe(404);
    expect(store.calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("with the secret but no provider key: 200, inert, ONE log line naming what is missing", async () => {
    setEnv({ CRON_SECRET: "cron-secret", TAOS_DAILY_EMAIL: "all" });
    const res = await call("Bearer cron-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "inert", sent: 0 });
    expect(logs).toEqual([
      "[taos-daily-email] run state=inert missing=RESEND_API_KEY,TAOS_EMAIL_FROM,TAOS_EMAIL_FOOTER_ADDRESS,TAOS_EMAIL_LINK_SECRET"
    ]);
    expect(store.calls).toEqual([]);
  });

  it("the default audience, with nothing set at all, is founders — not all", async () => {
    setEnv({ CRON_SECRET: "cron-secret" });
    expect(await (await call("Bearer cron-secret")).json()).toMatchObject({ audience: "founders" });
  });
});

describe("/api/email/prefs", () => {
  const post = async (body: unknown) => {
    const { POST } = await import("@/app/api/email/prefs/route");
    return POST(new NextRequest("https://taoslite.com/api/email/prefs", { method: "POST", body: JSON.stringify(body) }));
  };
  const get = async () => {
    const { GET } = await import("@/app/api/email/prefs/route");
    return GET(new NextRequest("https://taoslite.com/api/email/prefs"));
  };

  it("is signed-in only", async () => {
    expect((await get()).status).toBe(401);
    expect((await post({ action: "set", optedIn: true, timeZone: "UTC" })).status).toBe(401);
    expect(store.calls).toEqual([]);
  });

  it("answers `available: false` while the feature is inert, and stores nothing", async () => {
    caller = TOM;
    expect(await (await get()).json()).toEqual({ available: false });
    expect(await (await post({ action: "set", optedIn: true, timeZone: "UTC" })).json()).toEqual({ available: false });
    expect(store.calls).toEqual([]);
  });

  it("once configured, a founder reads and changes their own row; junk is refused", async () => {
    setEnv(ENV);
    vi.stubEnv("TAOS_DAILY_EMAIL", "founders");
    caller = TOM;
    expect(await (await get()).json()).toMatchObject({ available: true, prefs: { optedIn: true, hour: 8 } });
    expect(await (await post({ action: "set", hour: 7 })).json()).toMatchObject({ prefs: { hour: 7 } });
    expect(await (await post({ action: "set", hour: 99 })).json()).toMatchObject({ prefs: { hour: 7 } });
    expect((await post({ action: "delete-everything" })).status).toBe(400);
    expect((await post("nope")).status).toBe(400);
    // A customer under `founders` gets the same blank answer as an inert deployment.
    caller = { id: "33333333-3333-4333-8333-333333333333", email: "someone@example.test" };
    expect(await (await get()).json()).toEqual({ available: false });
  });
});

describe("/api/email/unsubscribe", () => {
  const url = (sig: string, user = TOM.id) => `https://taoslite.com/api/email/unsubscribe?u=${user}&s=${encodeURIComponent(sig)}`;
  const good = () => signUnsubscribe(TOM.id, store.rows.get(TOM.id)!.unsubscribe_token, ENV.TAOS_EMAIL_LINK_SECRET);

  it("POST with a good signature unsubscribes at once, signed-out, with an empty 200", async () => {
    setEnv(ENV);
    const { POST } = await import("@/app/api/email/unsubscribe/route");
    const res = await POST(new NextRequest(url(good()), { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(store.rows.get(TOM.id)).toMatchObject({ opted_in: false });
    expect(store.rows.get(TOM.id)?.unsubscribed_at).toBeTruthy();
    expect(logs).toEqual([`[taos-daily-email] unsubscribe user=${TOM.id} outcome=done`]);
  });

  it("a bad signature, a stranger's uuid, or a missing secret changes nothing", async () => {
    setEnv(ENV);
    const { POST } = await import("@/app/api/email/unsubscribe/route");
    expect((await POST(new NextRequest(url("forged"), { method: "POST" }))).status).toBe(400);
    expect((await POST(new NextRequest(url(good(), "99999999-9999-4999-8999-999999999999"), { method: "POST" }))).status).toBe(400);
    expect((await POST(new NextRequest(url(good(), "not-a-uuid"), { method: "POST" }))).status).toBe(400);
    vi.stubEnv("TAOS_EMAIL_LINK_SECRET", "");
    expect((await POST(new NextRequest(url(good()), { method: "POST" }))).status).toBe(400);
    expect(store.rows.get(TOM.id)).toMatchObject({ opted_in: true, unsubscribed_at: null });
  });

  it("GET (what a mail scanner does to every link) renders the page and unsubscribes nobody", async () => {
    setEnv(ENV);
    const { GET } = await import("@/app/api/email/unsubscribe/route");
    const res = await GET(new NextRequest(url(good())));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('method: "POST"');
    expect(store.rows.get(TOM.id)).toMatchObject({ opted_in: true, unsubscribed_at: null });
    const bad = await GET(new NextRequest(url("forged")));
    expect(bad.status).toBe(200);
    expect(await bad.text()).not.toContain("fetch(");
  });
});

describe("POST /api/email/webhook", () => {
  const secret = `whsec_${Buffer.from("webhook-signing-key").toString("base64")}`;
  const send = async (payload: unknown, opts: { sign?: boolean; ageSeconds?: number } = {}) => {
    const { POST } = await import("@/app/api/email/webhook/route");
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0));
    const signature = opts.sign === false ? "v1,AAAA" : `v1,${signWebhook(secret, "msg_1", ts, body)}`;
    return POST(
      new NextRequest("https://taoslite.com/api/email/webhook", {
        method: "POST",
        body,
        headers: { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": signature }
      })
    );
  };
  const bounce = { type: "email.bounced", data: { email_id: "e1", to: ["someone@example.test"], bounce: { type: "Permanent" }, tags: { uid: TOM.id } } };

  it("accepts nothing while the signing secret is unset", async () => {
    expect((await send(bounce)).status).toBe(503);
    expect(store.rows.get(TOM.id)?.bounced).toBe(false);
  });

  it("refuses an unsigned or stale request before reading it", async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: secret });
    expect((await send(bounce, { sign: false })).status).toBe(401);
    expect((await send(bounce, { ageSeconds: 600 })).status).toBe(401);
    expect(store.rows.get(TOM.id)?.bounced).toBe(false);
  });

  it("a signed bounce flips the flag; the log has a uuid and no address", async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: secret });
    const res = await send(bounce);
    expect(await res.json()).toEqual({ ok: true, handled: true });
    expect(store.rows.get(TOM.id)).toMatchObject({ bounced: true, opted_in: false });
    expect(logs).toEqual([`[taos-daily-email] webhook kind=bounce user=${TOM.id} outcome=flagged`]);
    expect(logs.join("")).not.toContain("@");
  });

  it("a bounce with no tag is matched by the provider's email id", async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: secret });
    store.rows.get(TOM.id)!.last_message_id = "e7";
    await send({ type: "email.bounced", data: { email_id: "e7" } });
    expect(store.rows.get(TOM.id)?.bounced).toBe(true);
  });

  it("a spam complaint is an unsubscribe; delivered/opened events are acknowledged and ignored", async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: secret });
    expect(await (await send({ type: "email.delivered", data: { tags: { uid: TOM.id } } })).json()).toEqual({ ok: true, handled: false });
    expect(store.rows.get(TOM.id)).toMatchObject({ opted_in: true, bounced: false });
    await send({ type: "email.complained", data: { email_id: "e1", tags: { uid: TOM.id } } });
    expect(store.rows.get(TOM.id)).toMatchObject({ opted_in: false, bounced: false });
    expect(store.rows.get(TOM.id)?.unsubscribed_at).toBeTruthy();
  });
});
