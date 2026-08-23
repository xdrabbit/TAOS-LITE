// What the first live purchase cost us.
//
// 2026-08-23, 01:02 UTC: Tom bought PREMIUM with a real card. Stripe charged
// $19.99, every webhook delivered 200, and the profile row still said
// `plan = 'free', tier = null`. The customer had paid and the app had not
// noticed. Two separate bugs, both pinned here:
//
//   1. **The stale snapshot.** Stripe delivers events concurrently and in no
//      guaranteed order, and each event carries the object as it looked when
//      the event was created. `customer.subscription.created` is minted before
//      the card is charged, so its snapshot says `status: "incomplete"`. It was
//      processed LAST — after `checkout.session.completed` had already written
//      the paid state — and its snapshot overwrote a paying customer back down
//      to free. The handler must re-read the subscription from Stripe, so a
//      late event is a redundant write instead of a downgrade.
//   2. **The vanished period end.** The account's API version carries the
//      billing window on the subscription *item*. The handler read the
//      top-level `current_period_end`, which no longer exists, so every sync
//      stored null.
//
// The first test is the one that matters: it replays the real event order.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const LIVE_PREMIUM = "price_live_premium";
const CUSTOMER = "cus_test123";
const SUB_ID = "sub_test123";
const USER_ID = "212f7b7d-531a-432f-aa24-41b76ae23019";
const PERIOD_END = 1790125349; // 2026-09-23T01:02:29Z

// ── The subscription, as Stripe currently holds it ─────────────────────────
// `retrieve` reads this, so a test can make the API disagree with the event
// snapshot — which is the whole point.
let liveSub: Record<string, unknown>;

function subscription(status: string) {
  return {
    id: SUB_ID,
    object: "subscription",
    status,
    customer: CUSTOMER,
    // Note: NO top-level current_period_end. That is the real payload shape
    // under API version 2026-05-27.dahlia, and hardcoding its absence here is
    // what keeps bug 2 fixed.
    items: { data: [{ current_period_end: PERIOD_END, price: { id: LIVE_PREMIUM } }] }
  };
}

// ── The event we hand the route ────────────────────────────────────────────
let event: Record<string, unknown>;

vi.mock("@/lib/stripe", () => ({
  stripe: {
    webhooks: { constructEvent: () => event },
    subscriptions: { retrieve: async () => liveSub }
  },
  tierForPrice: (priceId: string | null) => (priceId === LIVE_PREMIUM ? "premium" : null)
}));

// ── The profile row ────────────────────────────────────────────────────────
// A one-row stand-in for `profiles`, so the assertions read the state the
// customer would actually be in.
let row: Record<string, unknown>;

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: () => ({
      update: (fields: Record<string, unknown>) => ({
        eq: async () => {
          Object.assign(row, fields);
          return { data: null, error: null };
        }
      }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row }) }) })
    })
  }
}));

async function deliver(type: string, object: Record<string, unknown>) {
  const { POST } = await import("@/app/api/stripe/webhook/route");
  event = { type, data: { object } };
  const res = await POST(
    new NextRequest("https://taoslite.com/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=pretend" },
      body: "{}"
    })
  );
  expect(res.status).toBe(200);
}

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_pretend";
  process.env.STRIPE_SECRET_KEY = "sk_live_pretend";
  row = { id: USER_ID, plan: "free", tier: null, subscription_status: null };
  liveSub = subscription("active");
});

describe("the live-fire regression: a paying customer is not downgraded", () => {
  it("survives customer.subscription.created arriving LAST, incomplete", async () => {
    // The exact order Stripe used on 2026-08-23, with the created event —
    // carrying its pre-charge `incomplete` snapshot — processed last.
    await deliver("customer.subscription.updated", subscription("active"));
    await deliver("checkout.session.completed", {
      mode: "subscription",
      client_reference_id: USER_ID,
      subscription: SUB_ID
    });
    await deliver("customer.subscription.created", subscription("incomplete"));

    // Before the fix this row read free / null: the stale snapshot won.
    expect(row.subscription_status).toBe("active");
    expect(row.plan).toBe("pro");
    expect(row.tier).toBe("premium");
  });

  it("stores current_period_end from the subscription item, not the missing top-level field", async () => {
    await deliver("checkout.session.completed", {
      mode: "subscription",
      client_reference_id: USER_ID,
      subscription: SUB_ID
    });
    expect(row.current_period_end).toBe(new Date(PERIOD_END * 1000).toISOString());
  });

  it("records the customer and subscription ids", async () => {
    await deliver("customer.subscription.created", subscription("incomplete"));
    expect(row.stripe_customer_id).toBe(CUSTOMER);
    expect(row.stripe_subscription_id).toBe(SUB_ID);
  });
});

describe("the exit door still works", () => {
  it("drops to free when the subscription is really gone", async () => {
    await deliver("checkout.session.completed", {
      mode: "subscription",
      client_reference_id: USER_ID,
      subscription: SUB_ID
    });
    expect(row.tier).toBe("premium");

    // Cancel: Stripe now holds a canceled subscription, and the deleted event
    // agrees with it.
    liveSub = subscription("canceled");
    await deliver("customer.subscription.deleted", subscription("canceled"));

    expect(row.subscription_status).toBe("canceled");
    expect(row.plan).toBe("free");
    expect(row.tier).toBeNull();
  });

  it("does not let a stale 'active' event resurrect a canceled subscription", async () => {
    liveSub = subscription("canceled");
    await deliver("customer.subscription.updated", subscription("active"));
    expect(row.plan).toBe("free");
    expect(row.tier).toBeNull();
  });
});
