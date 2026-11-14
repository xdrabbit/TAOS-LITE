// The safety net under the webhook.
//
// The webhook is the only thing that grants an entitlement, and it can answer
// 200 over a profile row that never changed (2026-08-23). Once a day the sweep
// asks from the other end: of the checkouts Stripe calls complete and paid in
// the last 48 hours, which never landed? Tom, 2026-11-14: LOG ONLY — one
// `[taos-stripe-reconcile]` line per gap, ids only, no auto-granting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.UTC(2026, 10, 14, 19, 0, 0);
const USER = "3137dbb4-0000-4000-8000-000000000001";

const h = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  listArgs: [] as Record<string, unknown>[],
  listThrows: false,
  profiles: new Map<string, Record<string, unknown>>(),
  credits: new Set<string>(),
  writes: [] as string[]
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {
    checkout: {
      sessions: {
        list: async (args: Record<string, unknown>) => {
          h.listArgs.push(args);
          if (h.listThrows) throw Object.assign(new Error("nope"), { type: "StripeConnectionError" });
          return { data: h.sessions, has_more: false };
        }
      }
    }
  }
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const refuse = (verb: string) => () => {
        h.writes.push(`${verb}:${table}`);
        throw new Error("reconcile must not write");
      };
      return {
        insert: refuse("insert"),
        update: refuse("update"),
        upsert: refuse("upsert"),
        delete: refuse("delete"),
        select: () => ({
          eq: (_column: string, value: string) => ({
            maybeSingle: async () => ({
              data:
                table === "stripe_pack_credits"
                  ? h.credits.has(value) ? { checkout_session_id: value } : null
                  : (h.profiles.get(value) ?? null),
              error: null
            })
          })
        })
      };
    }
  }
}));

const details = { email: "buyer@example.com", name: "Pat Buyer" };

function sub(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    client_reference_id: USER,
    customer: "cus_abc",
    subscription: "sub_new",
    amount_total: 1999,
    metadata: {},
    customer_details: details,
    ...over
  };
}

function pack(id: string) {
  return {
    id,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    client_reference_id: USER,
    customer: "cus_abc",
    amount_total: 999,
    metadata: { kind: "pack", pack_minutes: "100", user_id: USER },
    customer_details: details
  };
}

let lines: string[];
const tagged = () => lines.filter((l) => l.startsWith("[taos-stripe-reconcile]"));

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_live_pretend";
  h.sessions = [];
  h.listArgs.length = 0;
  h.listThrows = false;
  h.profiles.clear();
  h.credits.clear();
  h.writes.length = 0;
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  const all = lines.join("\n");
  for (const secret of ["buyer@example.com", "Pat Buyer", "1999", "999 ", "sk_live_pretend"]) {
    expect(all).not.toContain(secret);
  }
  expect(h.writes).toEqual([]);
});

async function run() {
  const { reconcileCheckouts } = await import("@/lib/stripeReconcile");
  return reconcileCheckouts(NOW);
}

describe("what it asks Stripe for", () => {
  it("completed sessions created in the last 48 hours", async () => {
    await run();
    expect(h.listArgs[0].status).toBe("complete");
    expect(h.listArgs[0].created).toEqual({ gte: Math.floor(NOW / 1000) - 48 * 3600 });
  });
});

describe("a subscription checkout", () => {
  it("is quiet when the webhook wrote that subscription onto the profile", async () => {
    h.sessions = [sub("cs_ok")];
    h.profiles.set(USER, { id: USER, plan: "pro", subscription_status: "active", stripe_subscription_id: "sub_new" });
    const result = await run();
    expect(result).toEqual({ scanned: 1, paid: 1, gaps: 0, error: null });
    expect(tagged()).toEqual(["[taos-stripe-reconcile] window_h=48 scanned=1 paid=1 gaps=0 err=-"]);
  });

  it("is quiet when that subscription was granted and has since been canceled", async () => {
    h.sessions = [sub("cs_ok")];
    h.profiles.set(USER, { id: USER, plan: "free", subscription_status: "canceled", stripe_subscription_id: "sub_new" });
    expect((await run()).gaps).toBe(0);
  });

  it("LOGS when the customer paid and the profile is still free", async () => {
    h.sessions = [sub("cs_lost")];
    h.profiles.set(USER, { id: USER, plan: "free", subscription_status: "incomplete", stripe_subscription_id: null });
    const result = await run();
    expect(result.gaps).toBe(1);
    expect(tagged()[0]).toBe(
      `[taos-stripe-reconcile] gap=subscription_not_granted kind=subscription session=cs_lost customer=cus_abc user=${USER}` +
        " sub=sub_new reason=profile_not_synced profile_status=incomplete"
    );
  });

  it("LOGS when there is no profile to grant to at all", async () => {
    h.sessions = [sub("cs_orphan")];
    await run();
    expect(tagged()[0]).toContain("gap=subscription_not_granted");
    expect(tagged()[0]).toContain("reason=no_profile");
  });

  it("ignores a completed session that has not been paid yet", async () => {
    h.sessions = [sub("cs_pending", { payment_status: "unpaid" })];
    expect(await run()).toEqual({ scanned: 1, paid: 0, gaps: 0, error: null });
  });
});

describe("a minute-pack checkout", () => {
  it("is quiet when the credits ledger has the session", async () => {
    h.sessions = [pack("cs_pack_ok")];
    h.credits.add("cs_pack_ok");
    expect((await run()).gaps).toBe(0);
  });

  it("LOGS when it was paid and never credited", async () => {
    h.sessions = [pack("cs_pack_lost")];
    await run();
    expect(tagged()[0]).toBe(
      `[taos-stripe-reconcile] gap=pack_not_credited kind=pack session=cs_pack_lost customer=cus_abc user=${USER} reason=no_credit_row`
    );
  });
});

describe("it only ever logs", () => {
  it("never writes to the database, even with gaps on the table", async () => {
    h.sessions = [sub("cs_lost"), pack("cs_pack_lost")];
    const result = await run();
    expect(result.gaps).toBe(2);
    expect(h.writes).toEqual([]);
  });

  it("reports a Stripe failure by code instead of throwing into the sweep", async () => {
    h.listThrows = true;
    const result = await run();
    expect(result.error).toBe("StripeConnectionError");
    expect(tagged()).toEqual(["[taos-stripe-reconcile] window_h=48 scanned=0 paid=0 gaps=0 err=StripeConnectionError"]);
  });

  it("does nothing, and says so, without a Stripe key", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const result = await run();
    expect(result.error).toBe("no_stripe_key");
    expect(h.listArgs).toHaveLength(0);
  });
});

describe("where it runs", () => {
  it("rides the daily sweep, on the cron path only", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/walkie/sweep/route.ts", "utf8");
    expect(source).toMatch(/if \(isCron\) \{[^}]*reconcileCheckouts\(\)/);
  });
});
