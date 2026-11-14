// The Link "Processing…" hang.
//
// 2026-08-18 → 2026-11-14: every new checkout by four people stalled on
// Stripe's Link wallet page (checkout.link.com) and expired unpaid. Both
// session routes left the payment methods to the Dashboard, which put `link`
// in every session. Tom, 2026-11-14: card only, Link off, and the list must be
// changeable from an env var without a deploy.
//
// Pinned here: what the session is created WITH (not merely that create was
// called), and that neither new parameter can cost a sale — if Stripe rejects
// the request because of one of them, the route falls back to the request it
// sent before this change.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  /** Parameters Stripe should reject, by top-level name. */
  reject: new Set<string>(),
  hardFail: false
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          h.calls.push(args);
          if (h.hardFail) {
            throw Object.assign(new Error("card network down"), { type: "StripeAPIError" });
          }
          for (const name of h.reject) {
            if (name in args) {
              throw Object.assign(new Error(`Received unknown parameter: ${name}`), {
                type: "StripeInvalidRequestError",
                code: "parameter_unknown",
                param: name === "wallet_options" ? "wallet_options[link][display]" : `${name}[0]`
              });
            }
          }
          return { id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" };
        }
      }
    },
    customers: { create: async () => ({ id: "cus_test" }) }
  },
  priceForPlan: () => "price_basic",
  STRIPE_PACKS: { "100": { price: "price_pack_100", minutes: 100, amount: "$9.99", label: "100" } }
}));

vi.mock("@/lib/supabaseAdmin", () => {
  const chain: Record<string, unknown> = {
    maybeSingle: async () => ({
      data: { stripe_customer_id: "cus_test", subscription_status: "active" }
    })
  };
  chain.select = () => chain;
  chain.update = () => chain;
  chain.eq = () => chain;
  return { supabaseAdmin: { from: () => chain } };
});

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async () => ({ id: "user_1", email: "someone@example.com" })
}));

async function post(path: "checkout" | "pack", body: unknown) {
  const mod =
    path === "checkout"
      ? await import("@/app/api/stripe/checkout/route")
      : await import("@/app/api/stripe/pack/route");
  return mod.POST(
    new NextRequest(`https://taoslite.com/api/stripe/${path}`, {
      method: "POST",
      headers: { origin: "https://taoslite.com", "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

let logged: string[];

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_pretend";
  delete process.env.TAOS_CHECKOUT_PAYMENT_METHODS;
  h.calls.length = 0;
  h.reject.clear();
  h.hardFail = false;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TAOS_CHECKOUT_PAYMENT_METHODS;
});

describe.each([
  ["subscription checkout", "checkout", { plan: "premium" }],
  ["minute-pack checkout", "pack", { pack: "100" }]
] as const)("%s keeps Link off the page", (_name, path, body) => {
  it("asks for card only and tells Checkout never to display Link", async () => {
    const res = await post(path, body);
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].payment_method_types).toEqual(["card"]);
    expect(h.calls[0].wallet_options).toEqual({ link: { display: "never" } });
  });

  it("still returns Stripe's checkout url", async () => {
    const res = await post(path, body);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_123" });
  });
});

describe("TAOS_CHECKOUT_PAYMENT_METHODS re-adds methods without a deploy", () => {
  it("sends the listed methods, trimmed and lowercased, Link still hidden", async () => {
    process.env.TAOS_CHECKOUT_PAYMENT_METHODS = " card , CashApp,klarna ";
    await post("checkout", {});
    expect(h.calls[0].payment_method_types).toEqual(["card", "cashapp", "klarna"]);
    expect(h.calls[0].wallet_options).toEqual({ link: { display: "never" } });
  });

  it("listing `link` is the way back: the wallet switch is left alone", async () => {
    process.env.TAOS_CHECKOUT_PAYMENT_METHODS = "card,link";
    await post("checkout", {});
    expect(h.calls[0].payment_method_types).toEqual(["card", "link"]);
    expect("wallet_options" in h.calls[0]).toBe(false);
  });

  it.each(["", "   ", ",,", '"; drop']) ("falls back to card on a junk value (%j)", async (value) => {
    process.env.TAOS_CHECKOUT_PAYMENT_METHODS = value;
    await post("checkout", {});
    expect(h.calls[0].payment_method_types).toEqual(["card"]);
  });

  it("is read per request, not at import", async () => {
    await post("checkout", {});
    process.env.TAOS_CHECKOUT_PAYMENT_METHODS = "card,cashapp";
    await post("checkout", {});
    expect(h.calls[0].payment_method_types).toEqual(["card"]);
    expect(h.calls[1].payment_method_types).toEqual(["card", "cashapp"]);
  });
});

describe("the fix cannot cost a sale", () => {
  it("drops wallet_options and retries when Stripe does not know it", async () => {
    h.reject.add("wallet_options");
    const res = await post("checkout", {});
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(2);
    expect("wallet_options" in h.calls[1]).toBe(false);
    expect(h.calls[1].payment_method_types).toEqual(["card"]);
    expect(logged.some((l) => l.includes("[taos-checkout]") && l.includes("degraded=1"))).toBe(true);
  });

  it("falls all the way back to the old request when the method list is rejected too", async () => {
    h.reject.add("wallet_options");
    h.reject.add("payment_method_types");
    const res = await post("checkout", {});
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(3);
    expect("wallet_options" in h.calls[2]).toBe(false);
    expect("payment_method_types" in h.calls[2]).toBe(false);
    // What the route sent before this change is still all there.
    expect(h.calls[2].mode).toBe("subscription");
    expect(h.calls[2].client_reference_id).toBe("user_1");
  });

  it("does NOT retry a failure that is not about a parameter it added", async () => {
    h.hardFail = true;
    const res = await post("checkout", {});
    expect(res.status).toBe(500);
    expect(h.calls).toHaveLength(1);
  });
});

describe("the checkout log line", () => {
  it("names the session and the shape, and nothing about the person", async () => {
    await post("checkout", {});
    const line = logged.find((l) => l.startsWith("[taos-checkout]"));
    expect(line).toContain("session=cs_test_123");
    expect(line).toContain("methods=card");
    expect(line).toContain("link=never");
    expect(line).toContain("outcome=ok");
    expect(logged.join("\n")).not.toContain("someone@example.com");
    expect(logged.join("\n")).not.toContain("sk_test_pretend");
  });
});
