// Fences the origins Stripe is allowed to send a customer back to.
//
// `success_url`, `cancel_url` and `return_url` are URLs Stripe redirects the
// browser to after checkout. All three used to be built by string-concatenating
// the request's own `Origin` header, which the caller controls — so anyone who
// could reach the route could mint a Stripe session that lands the customer on
// their host, with our checkout page as the referrer. Same open-redirect class
// as the 8/18 Google sign-in bug, and fixed with the same allow-list
// (lib/authRedirect.ts) rather than a second one.
//
// These are route-level on purpose. The allow-list itself is already pinned by
// tests/auth-redirect.test.ts; what is unpinned — and what a future edit would
// quietly undo — is that these three routes still run the header THROUGH it.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PRODUCTION_ORIGIN } from "@/lib/authRedirect";

const h = vi.hoisted(() => ({ sessions: [] as Record<string, unknown>[] }));

vi.mock("@/lib/stripe", () => {
  const capture = async (args: Record<string, unknown>) => {
    h.sessions.push(args);
    return { url: "https://checkout.stripe.com/c/pay/test" };
  };
  return {
    stripe: {
      checkout: { sessions: { create: capture } },
      billingPortal: { sessions: { create: capture } },
      customers: { create: async () => ({ id: "cus_test" }) }
    },
    priceForPlan: () => "price_basic",
    STRIPE_PACKS: { "100": { price: "price_pack_100", minutes: 100, amount: "$9.99", label: "100" } }
  };
});

vi.mock("@/lib/supabaseAdmin", () => {
  // The profile already has a customer id and an active sub, so every route
  // walks straight past its Stripe-customer and paywall branches to the line
  // under test.
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
  getUserFromRequest: async () => ({ id: "user_1", email: "tom@example.com" })
}));

interface Route {
  name: string;
  path: string;
  /** The session field Stripe will redirect the browser to. */
  field: string;
  load: () => Promise<{ POST: (req: NextRequest) => Promise<Response> }>;
  body: unknown;
}

const ROUTES: Route[] = [
  {
    name: "subscription checkout",
    path: "/api/stripe/checkout",
    field: "success_url",
    load: () => import("@/app/api/stripe/checkout/route"),
    body: { plan: "basic" }
  },
  {
    name: "tutor-minute pack",
    path: "/api/stripe/pack",
    field: "success_url",
    load: () => import("@/app/api/stripe/pack/route"),
    body: { pack: "100" }
  },
  {
    name: "billing portal",
    path: "/api/stripe/portal",
    field: "return_url",
    load: () => import("@/app/api/stripe/portal/route"),
    body: {}
  }
];

/**
 * POST to a route with the given Origin header and return the session Stripe
 * was asked to create. `host` is the URL the request arrived at — a separate
 * knob from Origin, because `req.url` used to be the fallback and must not be
 * trusted either.
 */
async function sessionFor(route: Route, origin: string | null, host = "https://taoslite.com") {
  const headers: Record<string, string> = {
    authorization: "Bearer test-token",
    "content-type": "application/json"
  };
  if (origin !== null) headers.origin = origin;

  const { POST } = await route.load();
  const res = await POST(
    new NextRequest(`${host}${route.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(route.body)
    })
  );
  expect(res.status, `${route.name} should have reached Stripe`).toBe(200);
  return h.sessions.at(-1)!;
}

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fence";
});

afterEach(() => {
  h.sessions.length = 0;
});

describe.each(ROUTES)("$name: where Stripe may send the customer", (route) => {
  it("keeps a real preview deployment on that preview", async () => {
    // The whole reason this isn't hardcoded to production: buying a plan on a
    // preview build has to come back to the preview, or the tester lands on
    // prod without noticing — the 8/18 bug, wearing a checkout page.
    const preview = "https://taos-lite-git-feat-trip-mode-xdrabbits-projects.vercel.app";
    const session = await sessionFor(route, preview);
    expect(session[route.field]).toMatch(new RegExp(`^${preview}(/|$)`));
  });

  it("sends an attacker's origin to production instead", async () => {
    const session = await sessionFor(route, "https://evil.com");
    expect(session[route.field]).toMatch(new RegExp(`^${PRODUCTION_ORIGIN}(/|$)`));
  });

  it("sends a lookalike suffix to production too", async () => {
    const session = await sessionFor(route, "https://taoslite.com.evil.com");
    expect(session[route.field]).toMatch(new RegExp(`^${PRODUCTION_ORIGIN}(/|$)`));
  });

  it("falls back to production when there is no Origin header at all", async () => {
    // Arriving at an attacker-supplied Host, to prove the old
    // `new URL(req.url).origin` fallback is really gone and not just reordered.
    const session = await sessionFor(route, null, "https://evil.com");
    expect(session[route.field]).toMatch(new RegExp(`^${PRODUCTION_ORIGIN}(/|$)`));
  });
});

describe("the production happy path is byte-identical to before the fence", () => {
  // The fence is worthless if it changes what a real customer's checkout looks
  // like. These are the exact strings the routes built on 8/18.
  it("subscription checkout", async () => {
    const s = await sessionFor(ROUTES[0], PRODUCTION_ORIGIN);
    expect(s.success_url).toBe("https://taoslite.com/?checkout=success");
    expect(s.cancel_url).toBe("https://taoslite.com/?checkout=cancel");
  });

  it("tutor-minute pack", async () => {
    const s = await sessionFor(ROUTES[1], PRODUCTION_ORIGIN);
    expect(s.success_url).toBe("https://taoslite.com/tutor?pack=success");
    expect(s.cancel_url).toBe("https://taoslite.com/tutor?pack=cancel");
  });

  it("billing portal", async () => {
    const s = await sessionFor(ROUTES[2], PRODUCTION_ORIGIN);
    expect(s.return_url).toBe("https://taoslite.com");
  });

  it("and www stays on www rather than bouncing to the apex", async () => {
    const s = await sessionFor(ROUTES[0], "https://www.taoslite.com");
    expect(s.success_url).toBe("https://www.taoslite.com/?checkout=success");
  });
});
