import Stripe from "stripe";

// Server-only Stripe client. STRIPE_SECRET_KEY must be set in the environment
// (never shipped to the browser).
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  // Pin nothing here — use the account's default API version.
  typescript: true
});

// Test-mode price ids, kept only so local and preview work needs no env setup.
// In production they are a trap: an unset price var used to fall through to one
// of these silently, so a real customer would be sent to a checkout session
// built from a price the live account cannot charge — a 500 at the till with no
// hint that a *config* var, not Stripe, was wrong. `requirePrice` below makes
// production refuse both the fallback and the test id itself.
const TEST_PRICES = {
  STRIPE_PRICE_BASIC: "price_1TkTtGHolcC19vGUnn5y0Lvs", // $5.99/mo
  STRIPE_PRICE_PREMIUM: "price_1TkVDeHolcC19vGUnQrR6H8t", // $19.99/mo
  STRIPE_PACK_100: "price_1TkZV3HolcC19vGUE6ALKSQe", // $9.99
  STRIPE_PACK_200: "price_1TkZV5HolcC19vGUu9QAX0rG" // $17.99
} as const;

type PriceEnv = keyof typeof TEST_PRICES;

function inProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
}

function configuredPrice(name: PriceEnv): string {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  // Legacy single-price env, from before Basic and Premium split.
  if (name === "STRIPE_PRICE_BASIC") return process.env.STRIPE_PRICE_ID?.trim() ?? "";
  return "";
}

// Resolved at call time, not at import: a throw here must reach the request
// that needed the price, not the build that imported the module.
export function requirePrice(name: PriceEnv): string {
  const value = configuredPrice(name);
  if (!inProduction()) return value || TEST_PRICES[name];

  assertLiveKey();
  if (!value) {
    throw new Error(
      `[stripe] ${name} is not set in production. Set it to the live price id — ` +
        `production will not fall back to the test-mode price.`
    );
  }
  if (value === TEST_PRICES[name]) {
    throw new Error(
      `[stripe] ${name} is set to the test-mode price id ${value} in production. ` +
        `Set it to the live price id.`
    );
  }
  return value;
}

// A test key in production takes real card details and charges nobody, which
// looks like success from the customer's side. Same fail-loud rule as prices.
export function assertLiveKey(): void {
  if (!inProduction()) return;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("[stripe] STRIPE_SECRET_KEY is not set in production.");
  if (key.startsWith("sk_test_")) {
    throw new Error("[stripe] STRIPE_SECRET_KEY is a test-mode key in production.");
  }
}

export type PlanId = "basic" | "premium";

export function priceForPlan(plan: PlanId): string {
  return requirePrice(plan === "premium" ? "STRIPE_PRICE_PREMIUM" : "STRIPE_PRICE_BASIC");
}

// Map a Stripe price id back to our tier label (used by the webhook).
export function tierForPrice(priceId: string | null | undefined): "basic" | "premium" | null {
  if (!priceId) return null;
  if (priceId === requirePrice("STRIPE_PRICE_PREMIUM")) return "premium";
  if (priceId === requirePrice("STRIPE_PRICE_BASIC")) return "basic";
  return null;
}

// One-time add-on minute packs (month-scoped bonus). Buyable by paying users
// when they run out of their monthly tutor minutes. `price` is a getter so the
// guard runs when a route reaches for the id, not when the module loads.
export interface Pack {
  price: string;
  minutes: number;
  amount: string;
  label: string;
}
export const STRIPE_PACKS: Record<string, Pack> = {
  "100": {
    get price() {
      return requirePrice("STRIPE_PACK_100");
    },
    minutes: 100,
    amount: "$9.99",
    label: "100 tutor minutes"
  },
  "200": {
    get price() {
      return requirePrice("STRIPE_PACK_200");
    },
    minutes: 200,
    amount: "$17.99",
    label: "200 tutor minutes"
  }
};
export type PackId = keyof typeof STRIPE_PACKS;
