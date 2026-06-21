import Stripe from "stripe";

// Server-only Stripe client. STRIPE_SECRET_KEY must be set in the environment
// (never shipped to the browser).
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  // Pin nothing here — use the account's default API version.
  typescript: true
});

// Subscription prices. Defaults are the test-mode prices; override per
// environment (live prices in production).
export const STRIPE_PRICE_BASIC =
  process.env.STRIPE_PRICE_BASIC?.trim() ||
  process.env.STRIPE_PRICE_ID?.trim() || // legacy single-price env
  "price_1TkTtGHolcC19vGUnn5y0Lvs"; // $5.99/mo
export const STRIPE_PRICE_PREMIUM =
  process.env.STRIPE_PRICE_PREMIUM?.trim() || "price_1TkVDeHolcC19vGUnQrR6H8t"; // $19.99/mo

export type PlanId = "basic" | "premium";

export function priceForPlan(plan: PlanId): string {
  return plan === "premium" ? STRIPE_PRICE_PREMIUM : STRIPE_PRICE_BASIC;
}

// Map a Stripe price id back to our tier label (used by the webhook).
export function tierForPrice(priceId: string | null | undefined): "basic" | "premium" | null {
  if (!priceId) return null;
  if (priceId === STRIPE_PRICE_PREMIUM) return "premium";
  if (priceId === STRIPE_PRICE_BASIC) return "basic";
  return null;
}

// Back-compat: some callers still import STRIPE_PRICE_ID.
export const STRIPE_PRICE_ID = STRIPE_PRICE_BASIC;

// One-time add-on minute packs (month-scoped bonus). Buyable by paying users
// when they run out of their monthly tutor minutes.
export interface Pack {
  price: string;
  minutes: number;
  amount: string;
  label: string;
}
export const STRIPE_PACKS: Record<string, Pack> = {
  "100": {
    price: process.env.STRIPE_PACK_100?.trim() || "price_1TkZV3HolcC19vGUE6ALKSQe",
    minutes: 100,
    amount: "$9.99",
    label: "100 tutor minutes"
  },
  "200": {
    price: process.env.STRIPE_PACK_200?.trim() || "price_1TkZV5HolcC19vGUu9QAX0rG",
    minutes: 200,
    amount: "$17.99",
    label: "200 tutor minutes"
  }
};
export type PackId = keyof typeof STRIPE_PACKS;
