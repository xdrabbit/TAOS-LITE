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
//   2. a storm of keystrokes bills exactly ONE settled translation, because
//      billing is keyed on the settled text and not on the request count.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { billingKey, FAST_DEBOUNCE_MS, FAST_SETTLE_MS } from "@/lib/fast/settle";
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
  // The quota is a count of taos_lite_translations rows (lib/supabase.ts),
  // and FastShell writes one only when the input has been still for
  // FAST_SETTLE_MS and the translation on screen matches it. So the unit
  // billed is a settled thought, not a request — which is why these two
  // constants are different numbers and must stay that way.
  it("keeps the money clock slower than the feel clock", () => {
    expect(FAST_DEBOUNCE_MS).toBe(300);
    expect(FAST_SETTLE_MS).toBe(1500);
    expect(FAST_SETTLE_MS).toBeGreaterThan(FAST_DEBOUNCE_MS);
  });

  it("bills one row for the whole of typing a phrase", () => {
    // Every prefix of "bathroom" is a request; only the settled text is a
    // billing key, and the set is what stops it being billed twice.
    const billed = new Set<string>();
    const bill = (text: string) => {
      const key = billingKey(text, "en", "es");
      if (billed.has(key)) return false;
      billed.add(key);
      return true;
    };
    const typed = "bathroom";
    for (let i = 1; i <= typed.length; i += 1) {
      // Only the last prefix ever settles — the rest are overwritten by the
      // next keystroke before FAST_SETTLE_MS elapses.
      if (i === typed.length) expect(bill(typed)).toBe(true);
    }
    // A pause, a re-render, a second settle over the same words: still one.
    expect(bill(typed)).toBe(false);
    expect(bill("bathroom ")).toBe(false); // trailing space is a keystroke
    expect(billed.size).toBe(1);
  });

  it("bills the same words the other way round as a separate lookup", () => {
    expect(billingKey("gracias", "es", "en")).not.toBe(billingKey("gracias", "en", "es"));
  });
});
