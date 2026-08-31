// The keystroke-storm fence.
//
// /fast is the only route in this app that is CALLED WHILE SOMEBODY IS STILL
// TYPING, which means "lots of requests a minute from one account" is its
// normal shape and there is no burst that looks wrong from outside. The
// client debounces at 300ms — but a debounce is a courtesy the browser
// extends, and a held key, a retry loop, or a script does not extend it.
//
// Two separate things are proved here, and conflating them is the bug this
// screen could most easily have shipped:
//   1. the server caps how many TRANSLATIONS one account can buy per minute;
//   2. a storm of keystrokes bills exactly ONE translation, because the unit
//      billed is a settled thought and not a request.
//
// This file covers the in-process half of (1) — the free fast path that
// refuses a storm before the body is read. The DURABLE half, and the whole of
// (2), moved server-side on 8/31 and are pinned in tests/fast-metering.test.ts:
// billing used to be a browser timer writing its own row, which meant a caller
// who declined to run it was never billed at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { FAST_DEBOUNCE_MS, FAST_SETTLE_MS } from "@/lib/fast/settle";
import { checkFastRate, resetFastRateLimits } from "@/lib/fast/rateLimit";

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) =>
    req.headers.get("authorization")?.startsWith("Bearer ") && caller ? caller : null
}));

const fetchSpy = vi.fn(
  async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "hola" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
);

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

beforeEach(() => {
  resetFastRateLimits();
  caller = { id: "founder-1", email: "xdrabbit@gmail.com" };
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  // No service-role key: lib/fast/meter.ts runs unmetered off production
  // and says so in the log, which keeps these tests about the gate and
  // the in-process cap. Billing has its own file.
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.AZURE_TRANSLATOR_KEY;
  delete process.env.AZURE_TRANSLATOR_REGION;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  vi.resetModules();
});

describe("checkFastRate", () => {
  it("passes a fast typist's minute and refuses the sixty-first request", () => {
    for (let i = 0; i < 60; i += 1) {
      expect(checkFastRate("u", 1000).allowed).toBe(true);
    }
    expect(checkFastRate("u", 1000)).toEqual({ allowed: false, window: "minute" });
  });

  it("counts each account separately — one person's storm is not another's", () => {
    for (let i = 0; i < 60; i += 1) checkFastRate("noisy", 1000);
    expect(checkFastRate("noisy", 1000).allowed).toBe(false);
    expect(checkFastRate("quiet", 1000).allowed).toBe(true);
  });

  it("lets the window roll over a minute later", () => {
    for (let i = 0; i < 61; i += 1) checkFastRate("u", 1000);
    expect(checkFastRate("u", 1000).allowed).toBe(false);
    expect(checkFastRate("u", 1000 + 60_001).allowed).toBe(true);
  });

  it("still bounds an hour of runaway after the minute windows roll", () => {
    let now = 1000;
    let allowed = 0;
    // Ten minutes of a client that hits the per-minute ceiling every minute.
    for (let minute = 0; minute < 12; minute += 1) {
      for (let i = 0; i < 60; i += 1) {
        if (checkFastRate("u", now).allowed) allowed += 1;
      }
      now += 60_001;
    }
    expect(allowed).toBe(600);
    expect(checkFastRate("u", now)).toEqual({ allowed: false, window: "hour" });
  });

  it("does not burn the hour's budget on requests the minute already refused", () => {
    // Short-circuit ordering: 200 attempts inside one minute must cost the
    // HOURLY bucket 60, not 200 — otherwise one fast typist locks themselves
    // out for the rest of the hour on a single held key.
    let now = 1000;
    let allowed = 0;
    for (let i = 0; i < 200; i += 1) if (checkFastRate("u", now).allowed) allowed += 1;
    expect(allowed).toBe(60);

    // Nine more ordinary minutes. If the refused 140 had been counted, the
    // hour would run out partway through these.
    for (let minute = 0; minute < 9; minute += 1) {
      now += 60_001;
      for (let i = 0; i < 60; i += 1) if (checkFastRate("u", now).allowed) allowed += 1;
    }
    expect(allowed).toBe(600); // the whole hourly budget, and not a request less
    now += 60_001;
    expect(checkFastRate("u", now)).toEqual({ allowed: false, window: "hour" });
  });
});

describe("POST /api/fast under a keystroke storm", () => {
  it("serves the typing, then 429s rather than paying for a runaway", async () => {
    const { POST } = await import("@/app/api/fast/route");
    const send = (text: string) =>
      POST(
        new NextRequest("https://taoslite.com/api/fast", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
          body: JSON.stringify({ text, sourceLanguage: "en", targetLanguage: "es" })
        })
      );

    const statuses: number[] = [];
    for (let i = 0; i < 70; i += 1) statuses.push((await send(`where is the b${"a".repeat(i)}`)).status);

    expect(statuses.filter((s) => s === 200)).toHaveLength(60);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
    // The refusal is free: the provider was reached exactly as many times as
    // the cap allowed, never once for a request that was going to be denied.
    expect(fetchSpy).toHaveBeenCalledTimes(60);
  });

  it("refuses before reading the body, so a huge payload costs nothing either", async () => {
    const { POST } = await import("@/app/api/fast/route");
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../app/api/fast/route.ts", import.meta.url), "utf8")
    );
    expect(src.indexOf("checkFastRate(")).toBeLessThan(src.indexOf("await req.json()"));
    expect(POST).toBeTypeOf("function");
  });
});

describe("what a storm actually BILLS", () => {
  // The quota is a count of taos_lite_translations rows (lib/supabase.ts), and
  // the row is now written by POST /api/fast — once per BURST of previews,
  // where a burst ends when the gap between two requests exceeds
  // FAST_SETTLE_MS. So the unit billed is still a settled thought rather than
  // a request, which is why these two constants are different numbers and
  // must stay that way. What the burst rule actually costs is pinned against
  // the route in tests/fast-metering.test.ts.
  it("keeps the money clock slower than the feel clock", () => {
    expect(FAST_DEBOUNCE_MS).toBe(300);
    expect(FAST_SETTLE_MS).toBe(1500);
    expect(FAST_SETTLE_MS).toBeGreaterThan(FAST_DEBOUNCE_MS);
  });

  it("measures the settle where the caller cannot skip it", () => {
    // The constant is read by the SERVER meter now. If this import ever goes
    // back to being a browser-only timer, the meter goes back to being
    // optional — which was the bug.
    const meter = readFileSync(new URL("../lib/fast/meter.ts", import.meta.url), "utf8");
    expect(meter).toContain("FAST_SETTLE_MS");
    expect(meter).toContain("p_window_ms");
  });
});
