// The /fast cash register, pinned.
//
// #46 shipped this screen with the meter in the browser: POST /api/fast never
// asked the monthly allowance anything, and the bill was a
// `saveTranslation(...).catch(() => {})` in FastShell 1500ms after the typing
// stopped. Every test below is a way somebody could have had /fast for free,
// or been charged for something they did not get.
//
// The assertions are on NUMBERS — rows written, allowance left, statuses —
// and on ONE thing besides: whether the provider was reached at all. A 402
// returned after paying OpenAI is the same bill with better manners, so the
// fetch spy is checked on every refusal.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { FAST_PLAN_TRANSLATIONS } from "@/lib/fast/meter";
import { FAST_REPEAT_MS, FAST_SETTLE_MS } from "@/lib/fast/settle";
import { QUOTAS, type Tier } from "@/lib/supabase";

import { FastMeterDb } from "./helpers/fastMeterDb";

// The route's other end. tests/helpers/fastMeterDb.ts says what it is and,
// more importantly, what it is not: it drives the ORDER the route does things
// in, and it is not the proof that the plpgsql is right.
const db = new FastMeterDb();
const rpcSpy = vi.fn(db.rpc);

vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: { rpc: (name: string, args: Record<string, unknown>) => rpcSpy(name, args) }
}));

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) =>
    req.headers.get("authorization")?.startsWith("Bearer ") && caller ? caller : null
}));

// The translation provider. Answers in whichever shape was asked for, so auto
// mode (json_object) does not fail for the wrong reason.
const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
  const sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  const json = (sent.response_format as { type?: string } | undefined)?.type === "json_object";
  const content = json ? JSON.stringify({ sourceLang: "en", translation: "hola" }) : "hola";
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_ENV = process.env.VERCEL_ENV;

beforeEach(async () => {
  db.reset();
  rpcSpy.mockClear();
  fetchSpy.mockClear();
  // A non-founder on the free tier: the person the allowance is for.
  caller = { id: "u1", email: "stranger@example.com" };
  db.profiles.set("u1", { subscription_status: "trialing", tier: null });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.NEXT_PUBLIC_ENABLE_FAST = "1";
  delete process.env.VERCEL_ENV;
  delete process.env.AZURE_TRANSLATOR_KEY;
  delete process.env.AZURE_TRANSLATOR_REGION;
  const { resetFastRateLimits } = await import("@/lib/fast/rateLimit");
  resetFastRateLimits();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_ENV === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = ORIGINAL_ENV;
  delete process.env.NEXT_PUBLIC_ENABLE_FAST;
  vi.resetModules();
});

async function post(
  body: Record<string, unknown>,
  opts: { token?: string; origin?: string | null } = {}
) {
  const { POST } = await import("@/app/api/fast/route");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.origin) headers.Origin = opts.origin;
  return POST(
    new NextRequest("https://taoslite.com/api/fast", {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    })
  );
}

/** One preview, the way FastShell sends them: pair named, direction auto. */
const preview = (text: string) => ({
  text,
  sourceLanguage: "en",
  targetLanguage: "es",
  direction: "auto"
});

// ── The allowances the pricing page sells ───────────────────────────────────

describe("the cap the server enforces", () => {
  it("is the same number the browser shows", () => {
    // The server cannot import lib/supabase.ts's browser client at runtime, so
    // the numbers exist twice. This is the fence that keeps them equal: a tier
    // that says unlimited in the UI and enforces 25 on the server is a support
    // email that looks exactly like a bug in /fast.
    for (const tier of Object.keys(QUOTAS) as Tier[]) {
      const shown = QUOTAS[tier].translations;
      const enforced = FAST_PLAN_TRANSLATIONS[tier];
      if (Number.isFinite(shown)) expect(enforced).toBe(shown);
      else expect(enforced).toBe(-1);
    }
  });

  it("is 25 a month on the free tier", () => {
    expect(FAST_PLAN_TRANSLATIONS.free).toBe(25);
  });
});

// ── The hole ────────────────────────────────────────────────────────────────

describe("the monthly allowance, enforced before the engine is called", () => {
  it("refuses a spent month with 402 and does not reach a provider", async () => {
    // 25 rows already this month — the free allowance, gone.
    for (let i = 0; i < 25; i += 1) {
      db.rows.push({
        id: `old-${i}`,
        user_id: "u1",
        created_at: db.now - 86_400_000,
        source_lang: "en",
        target_lang: "es",
        tone: "casual",
        original_text: "x",
        translation_text: "y",
        engine: "openai",
        fast_sealed_at: null
      });
    }

    const res = await post(preview("bathroom"), { token: "t" });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { reason?: string; used?: number; cap?: number };
    expect(body.reason).toBe("quota");
    expect(body.cap).toBe(25);
    // THE assertion. A refusal after paying for the translation is not a
    // refusal, it is a bill with a nicer message.
    expect(fetchSpy).not.toHaveBeenCalled();
    // And it bought nothing: still 25 rows, not 26.
    expect(db.monthRows("u1")).toHaveLength(25);
  });

  it("serves the twenty-fifth and refuses the twenty-sixth", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 26; i += 1) {
      // Each one its own burst: a pause longer than the settle window.
      db.now += FAST_SETTLE_MS + 1;
      statuses.push((await post(preview(`word ${i}`), { token: "t" })).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(25);
    expect(statuses.at(-1)).toBe(402);
    expect(fetchSpy).toHaveBeenCalledTimes(25);
    expect(db.monthRows("u1")).toHaveLength(25);
  });

  it("does not cap a subscriber", async () => {
    db.profiles.set("u1", { subscription_status: "active", tier: "basic" });
    for (let i = 0; i < 30; i += 1) {
      db.now += FAST_SETTLE_MS + 1;
      expect((await post(preview(`word ${i}`), { token: "t" })).status).toBe(200);
    }
    expect(db.monthRows("u1")).toHaveLength(30);
  });
});

// ── What a burst costs ──────────────────────────────────────────────────────

describe("one burst of typing is one billed quickie", () => {
  it("bills a phrase once, however many previews it took", async () => {
    // "bathroom", one preview per pause, all inside the settle window — the
    // shape FastShell's 300ms debounce actually produces.
    for (const text of ["bat", "bathr", "bathroom"]) {
      db.now += 320;
      expect((await post(preview(text), { token: "t" })).status).toBe(200);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3); // three translations rendered
    expect(db.monthRows("u1")).toHaveLength(1); // one thing asked for
    // The row holds the phrase that was finished, not the first fragment.
    expect(db.rows[0].original_text).toBe("bathroom");
    expect(db.rows[0].translation_text).toBe("hola");
  });

  it("bills again after a pause longer than the settle window", async () => {
    db.now += 320;
    await post(preview("where is the"), { token: "t" });
    db.now += FAST_SETTLE_MS + 1; // long enough that the client would have settled
    await post(preview("where is the bathroom"), { token: "t" });
    expect(db.monthRows("u1")).toHaveLength(2);
  });

  it("bills the same words the other way round as a separate lookup", async () => {
    db.now += 320;
    await post({ text: "gracias", sourceLanguage: "en", targetLanguage: "es" }, { token: "t" });
    db.now += 320; // well inside the window — it is the DIRECTION that changed
    await post({ text: "gracias", sourceLanguage: "es", targetLanguage: "en" }, { token: "t" });
    expect(db.monthRows("u1")).toHaveLength(2);
  });

  it("counts one person's typing separately from another's", async () => {
    db.profiles.set("u2", { subscription_status: "trialing", tier: null });
    db.now += 320;
    await post(preview("hello"), { token: "t" });
    caller = { id: "u2", email: "other@example.com" };
    db.now += 320;
    await post(preview("hello"), { token: "t" });
    expect(db.monthRows("u1")).toHaveLength(1);
    expect(db.monthRows("u2")).toHaveLength(1);
  });
});

// ── Parity: the UI has no privileges ────────────────────────────────────────

describe("a curl meters exactly like the screen", () => {
  it("bills a bare request with a valid session, with no browser involved", async () => {
    // No Origin, no Referer, nothing FastShell would send — just the token.
    // Under #46 this translated for free forever, because the only thing that
    // ever wrote the billing row was code running in the page.
    db.now += FAST_SETTLE_MS + 1;
    const res = await post(preview("bathroom"), { token: "t" });
    expect(res.status).toBe(200);
    expect(db.monthRows("u1")).toHaveLength(1);
    expect(db.rows[0].translation_text).toBe("hola");
    expect(db.rows[0].tone).toBe("literal");
  });

  it("runs a curl out of allowance on exactly the same count as the screen", async () => {
    for (let i = 0; i < 25; i += 1) {
      db.now += FAST_SETTLE_MS + 1;
      await post(preview(`word ${i}`), { token: "t" });
    }
    db.now += FAST_SETTLE_MS + 1;
    expect((await post(preview("one more"), { token: "t" })).status).toBe(402);
  });

  it("still answers a signed-out caller 401 without a provider call", async () => {
    // guardSpend runs first and /fast is founder-gated, so a stranger gets the
    // 404 the gate promises rather than anything about quotas.
    delete process.env.NEXT_PUBLIC_ENABLE_FAST;
    const res = await post(preview("bathroom"));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("401s a signed-out caller once /fast is public", async () => {
    // With the flag on, fastVisibleTo() passes for everyone and guardSpend is
    // the fence: no session, no spend. The spend-route rule, unchanged.
    caller = null;
    const res = await post(preview("bathroom"), { token: "t" });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rpcSpy).not.toHaveBeenCalled();
  });
});

// ── The durable rate limit ──────────────────────────────────────────────────

describe("the rate limit survives a cold start", () => {
  it("keeps refusing after the in-process window is wiped", async () => {
    process.env.TAOS_FAST_RATE_PER_MINUTE = "5";
    const { resetFastRateLimits } = await import("@/lib/fast/rateLimit");
    resetFastRateLimits();
    db.profiles.set("u1", { subscription_status: "active", tier: "basic" }); // no quota noise

    for (let i = 0; i < 5; i += 1) {
      expect((await post(preview(`a${i}`), { token: "t" })).status).toBe(200);
    }
    expect((await post(preview("a6"), { token: "t" })).status).toBe(429);

    // A new Fluid instance, or the same one after a cold start: module scope
    // is empty and the in-memory counter has forgotten everything. Under #46
    // this was the whole of the limit, so the sixty-first request simply
    // landed somewhere else and went through.
    resetFastRateLimits();
    const res = await post(preview("a7"), { token: "t" });
    expect(res.status).toBe(429);
    expect((await res.json()).reason).toBe("rate_minute");
    // The provider was reached five times: the cap, and not one request more.
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    delete process.env.TAOS_FAST_RATE_PER_MINUTE;
  });

  it("bounds the hour after the minute windows roll over", async () => {
    process.env.TAOS_FAST_RATE_PER_MINUTE = "5";
    process.env.TAOS_FAST_RATE_PER_HOUR = "8";
    const { resetFastRateLimits } = await import("@/lib/fast/rateLimit");
    resetFastRateLimits();
    db.profiles.set("u1", { subscription_status: "active", tier: "basic" });

    let served = 0;
    for (let minute = 0; minute < 4; minute += 1) {
      resetFastRateLimits(); // pretend each minute lands on a fresh instance
      for (let i = 0; i < 5; i += 1) {
        if ((await post(preview(`m${minute}i${i}`), { token: "t" })).status === 200) served += 1;
      }
      db.now += 60_000;
    }
    expect(served).toBe(8); // the hour's budget, durably, across four "instances"
    delete process.env.TAOS_FAST_RATE_PER_MINUTE;
    delete process.env.TAOS_FAST_RATE_PER_HOUR;
  });
});

// ── Nobody pays for a translation that never arrived ────────────────────────

describe("refunds and refusals", () => {
  it("gives the reservation back when the engine falls over", async () => {
    fetchSpy.mockImplementationOnce(
      async () => new Response("upstream on fire", { status: 500 })
    );
    db.now += FAST_SETTLE_MS + 1;
    const res = await post(preview("bathroom"), { token: "t" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    // The row it reserved is gone, and so is the burst — the next quickie
    // re-asks the allowance rather than inheriting a hold that bought nothing.
    expect(db.monthRows("u1")).toHaveLength(0);
    expect(db.quickies.get("u1")).toBeUndefined();
  });

  it("refuses rather than serving unmetered when the meter cannot answer", async () => {
    db.failBegin = true;
    const res = await post(preview("bathroom"), { token: "t" });
    expect(res.status).toBe(503);
    // No verdict means no reservation, and no reservation would mean a free
    // translation. The provider is never reached.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── The ordering, read off the source ───────────────────────────────────────
// The behaviours above run against a simulated Postgres. These two are about
// the shape of the real thing, which no simulation can vouch for.

describe("the money moves first", () => {
  const routeSrc = readFileSync(new URL("../app/api/fast/route.ts", import.meta.url), "utf8");
  const shellSrc = readFileSync(new URL("../components/FastShell.tsx", import.meta.url), "utf8");
  const sql = readFileSync(
    new URL("../supabase/migrations/20260831_fast_metering.sql", import.meta.url),
    "utf8"
  );

  it("reserves before it translates", () => {
    expect(routeSrc.indexOf("beginFastQuickie(")).toBeLessThan(
      routeSrc.indexOf("await fastTranslate(")
    );
  });

  it("still refuses a storm before reading the body", () => {
    expect(routeSrc.indexOf("checkFastRate(")).toBeLessThan(routeSrc.indexOf("await req.json()"));
  });

  it("no longer bills from the browser", () => {
    // The single line this whole change exists to delete.
    expect(shellSrc).not.toContain("saveTranslation");
    expect(shellSrc).not.toContain("billingKey");
  });

  it("checks the allowance before inserting the reservation row", () => {
    expect(sql.indexOf("'quota'")).toBeLessThan(sql.indexOf("insert into public.taos_lite_translations"));
  });

  it("keeps the meter's tables and functions off the browser's keyring", () => {
    // Service role only. A counter the counted party can write is not a
    // counter — the same rule public.tutor_usage is built on.
    expect(sql).toContain("alter table public.fast_rate enable row level security");
    expect(sql).toContain("alter table public.fast_quickies enable row level security");
    for (const fn of ["fast_begin", "fast_record", "fast_abandon"]) {
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?authenticated`));
    }
    expect(sql).not.toMatch(/create policy \w+ on public\.fast_/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The repeat window, with a floor under it
// ───────────────────────────────────────────────────────────────────────────
//
// Adoption has to match on a PREFIX — billing happens at the start of a
// burst, which is somebody's first few letters, so an exact-match rule would
// never fire while a phrase was being retyped. Unbounded, that made every
// short opener a key to an older row.
//
// What is pinned here is both halves at once, because either alone is a bug:
// the floor must stop "I" from opening "I need a doctor", AND the retype must
// still be free. The second is what took a second attempt.

/** One settled row, the way a real burst leaves one. */
async function settledQuickie(text: string) {
  db.now += FAST_SETTLE_MS + 1;
  const res = await post(preview(text), { token: "t" });
  expect(res.status).toBe(200);
  return db.rows.at(-1)!;
}

/** A burst, one preview per element, all inside the settle window. */
async function burst(...previews: string[]) {
  db.now += FAST_SETTLE_MS + 1;
  for (const text of previews) {
    db.now += 320;
    expect((await post(preview(text), { token: "t" })).status).toBe(200);
  }
}

describe("a short opener is not a question somebody already answered", () => {
  it("does not let 'I' latch onto 'I need a doctor'", async () => {
    await settledQuickie("I need a doctor");
    await burst("I");
    // Two rows: the doctor, and a genuinely new lookup that happens to start
    // with the same letter. Before the floor this was free AND invisible —
    // an adopted burst writes nothing, so the second question never reached
    // History at all.
    expect(db.monthRows("u1")).toHaveLength(2);
  });

  it("does not let 'the' latch onto anything at all", async () => {
    await settledQuickie("the bill please");
    await burst("the");
    expect(db.monthRows("u1")).toHaveLength(2);
  });

  it("does not let a whole word latch onto a longer phrase it opens", async () => {
    // "where" clears the four-character floor, so this is the case the LENGTH
    // rule alone would miss. It is refused because it neither spans a word
    // boundary nor is the stored phrase.
    await settledQuickie("where is the bank");
    await burst("where");
    expect(db.monthRows("u1")).toHaveLength(2);
  });

  it("still adopts a one-word quickie retyped in full", async () => {
    // The other side of the same rule: "water" is not a prefix of something
    // longer here, it IS the phrase. Refusing this would break the promise to
    // fix the hole.
    const first = await settledQuickie("water");
    await burst("wat", "water");
    expect(db.monthRows("u1")).toHaveLength(1);
    expect(db.rows[0].id).toBe(first.id);
  });
});

describe("the retype is still free, which is the whole reason for a repeat window", () => {
  it("costs nothing to clear the box and type the phrase again", async () => {
    // The promise #49's Clear button was built on. The burst opens by buying
    // a row on "where" — it must, there is nothing else to go on yet — and
    // then RECOGNISES itself as a retype and hands that row back.
    const first = await settledQuickie("where is the bank");
    await burst("where", "where is the", "where is the bank");
    expect(db.monthRows("u1")).toHaveLength(1);
    expect(db.rows[0].id).toBe(first.id);
    expect(db.rows[0].original_text).toBe("where is the bank");
  });

  it("costs nothing for a SHORT phrase, where the length rule alone would charge", async () => {
    // "how much" is eight characters, so it never reaches the twelve that
    // stands on its own. The proportional rule is what carries it: five
    // characters is 62% of the stored phrase.
    const first = await settledQuickie("how much");
    await burst("how", "how m", "how much");
    expect(db.monthRows("u1")).toHaveLength(1);
    expect(db.rows[0].id).toBe(first.id);
  });

  it("bills once the question actually diverges", async () => {
    await settledQuickie("where is the bank");
    await burst("where", "where is the", "where is the bathroom");
    // Adopted at "where is the", then diverged. The bathroom is a different
    // question and is billed as one.
    expect(db.monthRows("u1")).toHaveLength(2);
  });

  it("stops adopting once the window has passed", async () => {
    await settledQuickie("where is the bank");
    db.now += FAST_REPEAT_MS + 1;
    await burst("where", "where is the", "where is the bank");
    expect(db.monthRows("u1")).toHaveLength(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// An adopted row is History, and the database is what says so
// ───────────────────────────────────────────────────────────────────────────

describe("a sealed row refuses to be rewritten, whatever asks", () => {
  it("seals the row it adopts", async () => {
    const first = await settledQuickie("where is the pharmacy");
    expect(first.fast_sealed_at).toBeNull();
    await burst("where is the pharmacy");
    expect(db.rows[0].fast_sealed_at).not.toBeNull();
  });

  it("drops a direct fast_record against a sealed row and keeps the content", async () => {
    // The review's point, and it is about a defence that was one `if` deep:
    // `recordFastQuickie` skips the write when the row was adopted, and if
    // that check is ever dropped — a refactor, a new caller, a hand-typed
    // UPDATE in the SQL editor — a paid History entry is overwritten with
    // whatever is in somebody's box now. This call is that mistake, made on
    // purpose, with the JS check bypassed entirely.
    const first = await settledQuickie("where is the pharmacy");
    await burst("where is the pharmacy");

    await db.rpc("fast_record", {
      p_user_id: "u1",
      p_row_id: first.id,
      p_source_lang: "es",
      p_target_lang: "en",
      p_text: "asdf",
      p_translation: "garbage",
      p_engine: "fast"
    });

    expect(db.rows[0]).toMatchObject({
      original_text: "where is the pharmacy",
      translation_text: "hola",
      source_lang: "en",
      target_lang: "es"
    });
  });

  it("leaves an unsealed row writable, or the screen would stop working", () => {
    // The seal is narrow on purpose. Almost every row in this table has never
    // been near /fast, and a burst rewriting its OWN row as somebody types is
    // the normal path.
    db.rows.push({
      id: "live",
      user_id: "u1",
      created_at: db.now,
      source_lang: "en",
      target_lang: "es",
      tone: "literal",
      original_text: "wher",
      translation_text: "",
      engine: "fast",
      fast_sealed_at: null
    });
    db.fastRecord({
      p_user_id: "u1",
      p_row_id: "live",
      p_source_lang: "en",
      p_target_lang: "es",
      p_text: "where",
      p_translation: "dónde",
      p_engine: "fast"
    });
    expect(db.rows.at(-1)).toMatchObject({ original_text: "where", translation_text: "dónde" });
  });
});
