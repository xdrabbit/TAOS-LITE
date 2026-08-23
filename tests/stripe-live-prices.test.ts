// Pins the fail-loud price guard added for the 8/22 live-mode cutover.
//
// Before this, every price id had a hardcoded test-mode fallback. That is fine
// on a laptop and dangerous in production: unset STRIPE_PRICE_BASIC and the
// live account would be handed a test-mode price id, so the customer meets a
// generic checkout error and the logs say nothing about the missing var. The
// rule is now: in production (VERCEL_ENV === "production") a missing price var,
// a price var still holding the test id, or a test-mode secret key throws at
// first use — loudly, in the request that needed it, not at import time.
import { afterEach, describe, expect, it } from "vitest";
import { priceForPlan, requirePrice, tierForPrice, STRIPE_PACKS } from "@/lib/stripe";

const PRICE_ENVS = [
  "STRIPE_PRICE_BASIC",
  "STRIPE_PRICE_PREMIUM",
  "STRIPE_PACK_100",
  "STRIPE_PACK_200",
  "STRIPE_PRICE_ID"
] as const;

const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// A live-looking production environment; individual tests knock out one piece.
function productionEnv() {
  setEnv("VERCEL_ENV", "production");
  setEnv("STRIPE_SECRET_KEY", "sk_live_pretend");
  setEnv("STRIPE_PRICE_ID", undefined);
  setEnv("STRIPE_PRICE_BASIC", "price_live_basic");
  setEnv("STRIPE_PRICE_PREMIUM", "price_live_premium");
  setEnv("STRIPE_PACK_100", "price_live_pack100");
  setEnv("STRIPE_PACK_200", "price_live_pack200");
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe("price ids outside production", () => {
  it("falls back to the test-mode ids so local work needs no env setup", () => {
    setEnv("VERCEL_ENV", "development");
    for (const name of PRICE_ENVS) setEnv(name, undefined);
    expect(priceForPlan("basic")).toMatch(/^price_/);
    expect(priceForPlan("premium")).toMatch(/^price_/);
    expect(STRIPE_PACKS["100"].price).toMatch(/^price_/);
    expect(STRIPE_PACKS["200"].price).toMatch(/^price_/);
  });

  it("prefers an explicit env var over the fallback", () => {
    setEnv("VERCEL_ENV", "preview");
    setEnv("STRIPE_PRICE_BASIC", "price_preview_basic");
    expect(priceForPlan("basic")).toBe("price_preview_basic");
  });

  it("still honours the legacy STRIPE_PRICE_ID for basic", () => {
    setEnv("VERCEL_ENV", "preview");
    setEnv("STRIPE_PRICE_BASIC", undefined);
    setEnv("STRIPE_PRICE_ID", "price_legacy_basic");
    expect(priceForPlan("basic")).toBe("price_legacy_basic");
  });
});

describe("price ids in production", () => {
  it("uses the configured live ids", () => {
    productionEnv();
    expect(priceForPlan("basic")).toBe("price_live_basic");
    expect(priceForPlan("premium")).toBe("price_live_premium");
    expect(STRIPE_PACKS["100"].price).toBe("price_live_pack100");
    expect(STRIPE_PACKS["200"].price).toBe("price_live_pack200");
  });

  it.each(PRICE_ENVS.filter((n) => n !== "STRIPE_PRICE_ID"))(
    "throws when %s is unset instead of falling back to the test id",
    (name) => {
      productionEnv();
      setEnv(name, undefined);
      expect(() => requirePrice(name)).toThrow(new RegExp(`${name} is not set in production`));
    }
  );

  it("throws when a price var still holds the test-mode id", () => {
    productionEnv();
    // The value the old code fell back to, now set explicitly — still refused.
    setEnv("STRIPE_PRICE_BASIC", "price_1TkTtGHolcC19vGUnn5y0Lvs");
    expect(() => priceForPlan("basic")).toThrow(/test-mode price id/);
  });

  it("throws when basic is left to the legacy env holding a test id", () => {
    productionEnv();
    setEnv("STRIPE_PRICE_BASIC", undefined);
    setEnv("STRIPE_PRICE_ID", "price_1TkTtGHolcC19vGUnn5y0Lvs");
    expect(() => priceForPlan("basic")).toThrow(/test-mode price id/);
  });

  it("throws on a test-mode secret key", () => {
    productionEnv();
    setEnv("STRIPE_SECRET_KEY", "sk_test_pretend");
    expect(() => priceForPlan("basic")).toThrow(/test-mode key in production/);
  });

  it("throws when the secret key is missing entirely", () => {
    productionEnv();
    setEnv("STRIPE_SECRET_KEY", undefined);
    expect(() => priceForPlan("basic")).toThrow(/STRIPE_SECRET_KEY is not set/);
  });

  it("maps live price ids back to tiers, and unknown ids to null", () => {
    productionEnv();
    expect(tierForPrice("price_live_basic")).toBe("basic");
    expect(tierForPrice("price_live_premium")).toBe("premium");
    expect(tierForPrice("price_something_else")).toBeNull();
    expect(tierForPrice(null)).toBeNull();
  });
});

describe("the guard is lazy", () => {
  it("does not throw merely by importing the module in production", async () => {
    setEnv("VERCEL_ENV", "production");
    for (const name of PRICE_ENVS) setEnv(name, undefined);
    // A build imports every route module; that must not explode on a config
    // gap. Only a request that reaches for a price id does.
    await expect(import("@/lib/stripe")).resolves.toBeTruthy();
  });
});
