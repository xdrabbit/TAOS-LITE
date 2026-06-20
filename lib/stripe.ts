import Stripe from "stripe";

// Server-only Stripe client. STRIPE_SECRET_KEY must be set in the environment
// (never shipped to the browser).
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  // Pin nothing here — use the account's default API version.
  typescript: true
});

// The subscription price the paywall sells ($5.99/mo). Defaults to the test
// price; override per environment (live price for production).
export const STRIPE_PRICE_ID =
  process.env.STRIPE_PRICE_ID?.trim() || "price_1TkTtGHolcC19vGUnn5y0Lvs";
