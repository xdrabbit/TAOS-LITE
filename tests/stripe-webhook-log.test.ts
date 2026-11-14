// The webhook used to say nothing.
//
// Three months of stalled checkouts (2026-08-18 → 11-14) were diagnosed from
// Stripe's side alone because /api/stripe/webhook logged nothing a person could
// read: a delivery that granted Premium and one that changed no row were the
// same silence. Tom, 2026-11-14: one fields-only line per event —
// `[taos-stripe-webhook] type=… id=… session=… outcome=ok|error|ignored` —
// one for the fulfillment action, one for a failed signature, and NEVER an
// email, a name, an amount with an identity, or card data.
//
// The events below carry all of those on purpose. The privacy assertions are
// the point of this file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const USER_ID = "3137dbb4-0000-4000-8000-000000000001";
const PII = ["buyer@example.com", "Pat Buyer", "474 Somewhere Dr", "4242", "1999", "whsec_pretend", "sk_live_pretend"];

const h = vi.hoisted(() => ({
  event: null as Record<string, unknown> | null,
  badSignature: false,
  retrieveThrows: false,
  subStatus: "active",
  updateResult: { data: null, error: null, count: 1 } as Record<string, unknown>
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {
    webhooks: {
      constructEvent: () => {
        if (h.badSignature) {
          throw Object.assign(new Error("No signatures found matching the expected signature for payload buyer@example.com"), {
            type: "StripeSignatureVerificationError"
          });
        }
        return h.event;
      }
    },
    subscriptions: {
      retrieve: async () => {
        if (h.retrieveThrows) {
          throw Object.assign(new Error("boom for buyer@example.com"), { type: "StripeAPIError" });
        }
        return {
          id: "sub_abc",
          status: h.subStatus,
          customer: "cus_abc",
          items: { data: [{ current_period_end: 1790125349, price: { id: "price_premium" } }] }
        };
      }
    },
    checkout: { sessions: { retrieve: async () => ({ ...packSession(), payment_status: "paid" }) } }
  },
  tierForPrice: (id: string | null) => (id === "price_premium" ? "premium" : null)
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "stripe_pack_credits") return { insert: async () => ({ data: null, error: null }) };
      return {
        update: () => ({ eq: async () => h.updateResult }),
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { pack_seconds: 0 } }) }) })
      };
    }
  }
}));

// Everything a real session carries that must never reach a log line.
const customer_details = {
  email: "buyer@example.com",
  name: "Pat Buyer",
  address: { line1: "474 Somewhere Dr" }
};

function subscriptionSession() {
  return {
    id: "cs_live_sub1",
    object: "checkout.session",
    mode: "subscription",
    client_reference_id: USER_ID,
    subscription: "sub_abc",
    amount_total: 1999,
    customer_details
  };
}

function packSession() {
  return {
    id: "cs_live_pack1",
    object: "checkout.session",
    mode: "payment",
    client_reference_id: USER_ID,
    amount_total: 999,
    metadata: { kind: "pack", pack_minutes: "100", user_id: USER_ID },
    customer_details
  };
}

let lines: string[];

async function deliver(type: string, object: Record<string, unknown>, signature = "t=1,v1=pretend") {
  h.event = { id: "evt_123", type, data: { object } };
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(
    new NextRequest("https://taoslite.com/api/stripe/webhook", {
      method: "POST",
      headers: signature ? { "stripe-signature": signature } : {},
      body: JSON.stringify({ card: { last4: "4242" }, email: "buyer@example.com" })
    })
  );
}

const tagged = () => lines.filter((l) => l.startsWith("[taos-stripe-webhook]"));

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_pretend";
  process.env.STRIPE_SECRET_KEY = "sk_live_pretend";
  h.badSignature = false;
  h.retrieveThrows = false;
  h.subStatus = "active";
  h.updateResult = { data: null, error: null, count: 1 };
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const secret of PII) expect(lines.join("\n")).not.toContain(secret);
});

describe("one line per event received", () => {
  it("a completed subscription checkout: type, event id, session id, outcome=ok", async () => {
    const res = await deliver("checkout.session.completed", subscriptionSession());
    expect(res.status).toBe(200);
    expect(tagged()).toContain(
      "[taos-stripe-webhook] type=checkout.session.completed id=evt_123 session=cs_live_sub1 outcome=ok"
    );
  });

  it("an event with no session says session=-", async () => {
    await deliver("customer.subscription.updated", { id: "sub_abc", object: "subscription", customer: "cus_abc" });
    expect(tagged()).toContain(
      "[taos-stripe-webhook] type=customer.subscription.updated id=evt_123 session=- outcome=ok"
    );
  });

  it("an event type the handler does not read is outcome=ignored", async () => {
    await deliver("invoice.paid", { id: "in_1", object: "invoice", customer_email: "buyer@example.com" });
    expect(tagged()).toEqual(["[taos-stripe-webhook] type=invoice.paid id=evt_123 session=- outcome=ignored"]);
  });

  it("a processing failure is outcome=error, by code — and still a 200", async () => {
    h.retrieveThrows = true;
    const res = await deliver("checkout.session.completed", subscriptionSession());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, handled: false });
    expect(tagged()).toEqual([
      "[taos-stripe-webhook] type=checkout.session.completed id=evt_123 session=cs_live_sub1 outcome=error err=StripeAPIError"
    ]);
  });
});

describe("the fulfillment action", () => {
  it("names the entitlement granted and the user by uuid only", async () => {
    await deliver("checkout.session.completed", subscriptionSession());
    const action = tagged().find((l) => l.includes(" action "));
    expect(action).toContain("entitlement=premium_granted");
    expect(action).toContain(`user=${USER_ID}`);
    expect(action).toContain("sub=sub_abc");
    expect(action).toContain("rows=1");
    expect(action).toContain("db=ok");
  });

  it("says rows=0 when the write matched no profile — a 200 that granted nothing", async () => {
    h.updateResult = { data: null, error: null, count: 0 };
    await deliver("checkout.session.completed", subscriptionSession());
    expect(tagged().find((l) => l.includes(" action "))).toContain("rows=0");
  });

  it("surfaces a database error by code, not message", async () => {
    h.updateResult = { data: null, error: { code: "42501", message: "denied for buyer@example.com" }, count: null };
    await deliver("checkout.session.completed", subscriptionSession());
    expect(tagged().find((l) => l.includes(" action "))).toContain("db=error:42501");
  });

  it("a cancellation is entitlement=revoked", async () => {
    h.subStatus = "canceled";
    await deliver("customer.subscription.deleted", { id: "sub_abc", object: "subscription", customer: "cus_abc" });
    const action = tagged().find((l) => l.includes(" action "));
    expect(action).toContain("entitlement=revoked");
    expect(action).toContain("matched_by=customer");
  });

  it("a minute pack is entitlement=pack_credited against the session id", async () => {
    await deliver("checkout.session.completed", packSession());
    const action = tagged().find((l) => l.includes(" action "));
    expect(action).toContain("entitlement=pack_credited");
    expect(action).toContain("session=cs_live_pack1");
    expect(action).toContain(`user=${USER_ID}`);
  });
});

describe("failures that used to be invisible", () => {
  it("logs a rejected signature, and still answers 400", async () => {
    h.badSignature = true;
    const res = await deliver("checkout.session.completed", subscriptionSession());
    expect(res.status).toBe(400);
    expect(tagged()).toHaveLength(1);
    expect(tagged()[0]).toContain("signature=invalid");
    expect(tagged()[0]).toContain("has_header=1");
    expect(tagged()[0]).toContain("err=StripeSignatureVerificationError");
  });

  it("notes when the signature header was missing altogether", async () => {
    h.badSignature = true;
    await deliver("checkout.session.completed", subscriptionSession(), "");
    expect(tagged()[0]).toContain("has_header=0");
  });

  it("logs a missing signing secret as presence flags only", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await deliver("checkout.session.completed", subscriptionSession());
    expect(res.status).toBe(500);
    expect(tagged()).toEqual(["[taos-stripe-webhook] config=missing webhook_secret=0 secret_key=1"]);
  });
});
