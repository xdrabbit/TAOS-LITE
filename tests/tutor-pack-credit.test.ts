// A pack purchase turns into minutes exactly once.
//
// The money path was certified on 2026-08-23 with a real card, and the lesson
// from that day is written into tests/stripe-webhook-sync.test.ts: a green
// webhook proves nothing about the database. This file is the same lesson
// applied to the other product on the account — the one-time add-on minute
// packs — with two failure modes it did not have before tutor phase 2:
//
//   1. DOUBLE CREDIT. `checkout.session.completed` is redelivered on any
//      non-2xx, on a manual resend from the Stripe dashboard, and after a
//      timeout Stripe decided about on its own. The handler already answers
//      200 with `handled: false` on a processing hiccup, so a retry that
//      succeeds the second time would have credited twice under the old
//      read-add-write. `stripe_pack_credits` makes the checkout session id the
//      idempotency key.
//
//   2. CREDIT FOR AN UNPAID SESSION. The event's snapshot can say
//      `payment_status: "unpaid"` for the asynchronous payment methods, and
//      the PR #29 rule — never bill off the snapshot, re-read from Stripe —
//      applies here as it does to subscriptions.
//
// Everything below asserts on the BALANCE, never on "the handler ran".

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const USER_ID = "212f7b7d-531a-432f-aa24-41b76ae23019";
const CHECKOUT_ID = "cs_live_pack_abc";

// ── The checkout session, as Stripe currently holds it ─────────────────────
// `retrieve` reads this, so a test can make the API disagree with the event
// snapshot — which is the whole point of re-reading.
let liveCheckout: Record<string, unknown>;
let event: Record<string, unknown>;

function packSession(over: Record<string, unknown> = {}) {
  return {
    id: CHECKOUT_ID,
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    client_reference_id: USER_ID,
    metadata: { kind: "pack", pack_minutes: "100", user_id: USER_ID },
    ...over
  };
}

vi.mock("@/lib/stripe", () => ({
  stripe: {
    webhooks: { constructEvent: () => event },
    subscriptions: { retrieve: async () => ({ id: "sub_x", items: { data: [] } }) },
    checkout: { sessions: { retrieve: async () => liveCheckout } }
  },
  tierForPrice: () => null
}));

// ── The two tables this touches ────────────────────────────────────────────
// `profile.pack_seconds` is the balance the learner spends; `credits` is the
// idempotency ledger. Both are held here so the assertions read as the state a
// customer would actually be in.
let profile: Record<string, unknown>;
let credits: Map<string, Record<string, unknown>>;

vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "stripe_pack_credits") {
        return {
          insert: async (rowIn: Record<string, unknown>) => {
            const key = String(rowIn.checkout_session_id);
            if (credits.has(key)) {
              // What Postgres returns on a primary-key conflict. The boring,
              // expected case on a redelivery.
              return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
            credits.set(key, rowIn);
            return { data: null, error: null };
          }
        };
      }
      return {
        update: (fields: Record<string, unknown>) => ({
          eq: async () => {
            Object.assign(profile, fields);
            return { data: null, error: null };
          }
        }),
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile }) }) })
      };
    }
  }
}));

async function deliver(object: Record<string, unknown>) {
  const { POST } = await import("@/app/api/stripe/webhook/route");
  event = { type: "checkout.session.completed", data: { object } };
  const res = await POST(
    new NextRequest("https://taoslite.com/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=pretend" },
      body: "{}"
    })
  );
  // Always a 200: a non-2xx makes Stripe retry forever, which is exactly the
  // pressure the idempotency key exists to survive.
  expect(res.status).toBe(200);
}

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_pretend";
  process.env.STRIPE_SECRET_KEY = "sk_live_pretend";
  profile = { id: USER_ID, pack_seconds: 0 };
  credits = new Map();
  liveCheckout = packSession();
  vi.restoreAllMocks();
});

describe("a pack purchase credits minutes", () => {
  it("puts 100 minutes on the balance as 6000 seconds", async () => {
    await deliver(packSession());
    expect(profile.pack_seconds).toBe(100 * 60);
  });

  it("adds to an existing balance rather than replacing it", async () => {
    // Packs roll over, so a second purchase stacks on top of whatever survived
    // the month boundary.
    profile.pack_seconds = 30 * 60;
    liveCheckout = packSession({ id: "cs_live_pack_second" });
    await deliver(packSession({ id: "cs_live_pack_second" }));
    expect(profile.pack_seconds).toBe(130 * 60);
  });

  it("credits the 200-minute pack too", async () => {
    liveCheckout = packSession({ metadata: { kind: "pack", pack_minutes: "200", user_id: USER_ID } });
    await deliver(packSession({ metadata: { kind: "pack", pack_minutes: "200", user_id: USER_ID } }));
    expect(profile.pack_seconds).toBe(200 * 60);
  });
});

describe("replay safety", () => {
  it("credits once when Stripe delivers the same event three times", async () => {
    // The retry storm: same checkout session, three deliveries. Before the
    // idempotency ledger this was 300 minutes for one $9.99 charge.
    await deliver(packSession());
    await deliver(packSession());
    await deliver(packSession());
    expect(profile.pack_seconds).toBe(100 * 60);
    expect(credits.size).toBe(1);
  });

  it("still credits a DIFFERENT purchase by the same customer", async () => {
    // The key is the checkout session, not the user — buying two packs in one
    // afternoon has to work.
    await deliver(packSession());
    liveCheckout = packSession({ id: "cs_live_pack_two" });
    await deliver(packSession({ id: "cs_live_pack_two" }));
    expect(profile.pack_seconds).toBe(200 * 60);
    expect(credits.size).toBe(2);
  });

  it("claims the credit BEFORE crediting, so a crash cannot double-pay", async () => {
    // The claim row exists after the first delivery whatever happens next. If
    // the balance update were attempted first and the claim second, a failure
    // in between would leave a paid-out purchase with no record of it.
    await deliver(packSession());
    expect(credits.get(CHECKOUT_ID)).toMatchObject({ user_id: USER_ID, seconds: 100 * 60 });
  });
});

describe("never bill off the snapshot", () => {
  it("re-reads the session from Stripe and refuses an unpaid one", async () => {
    // The event snapshot says paid; Stripe currently says unpaid. Stripe wins.
    liveCheckout = packSession({ payment_status: "unpaid" });
    await deliver(packSession({ payment_status: "paid" }));
    expect(profile.pack_seconds).toBe(0);
    expect(credits.size).toBe(0);
  });

  it("credits when the snapshot was stale in the OTHER direction", async () => {
    // Snapshot unpaid, Stripe says paid — the asynchronous-payment case. The
    // customer's money is in; the minutes should be too.
    liveCheckout = packSession({ payment_status: "paid" });
    await deliver(packSession({ payment_status: "unpaid" }));
    expect(profile.pack_seconds).toBe(100 * 60);
  });
});

describe("malformed purchases credit nothing", () => {
  it("ignores a pack with no minutes in its metadata", async () => {
    const broken = packSession({ metadata: { kind: "pack", user_id: USER_ID } });
    liveCheckout = broken;
    await deliver(broken);
    expect(profile.pack_seconds).toBe(0);
  });

  it("ignores a pack with nobody to credit", async () => {
    const orphan = packSession({
      client_reference_id: null,
      metadata: { kind: "pack", pack_minutes: "100" }
    });
    liveCheckout = orphan;
    await deliver(orphan);
    expect(profile.pack_seconds).toBe(0);
  });

  it("leaves subscription checkouts to the subscription path", async () => {
    await deliver({
      id: "cs_live_sub",
      mode: "subscription",
      client_reference_id: USER_ID,
      subscription: "sub_x"
    });
    expect(profile.pack_seconds).toBe(0);
    expect(credits.size).toBe(0);
  });
});

describe("the month-scoped predecessor is gone", () => {
  it("never writes bonus_seconds or bonus_period again", async () => {
    // A pack bought on the 30th used to be worth almost nothing: the credit
    // was scoped to `bonus_period`, the calendar month it landed in. It is a
    // PURCHASE now, on a column no month boundary touches.
    await deliver(packSession());
    expect(profile).not.toHaveProperty("bonus_seconds");
    expect(profile).not.toHaveProperty("bonus_period");
    expect(profile.pack_seconds).toBe(100 * 60);
  });
});
