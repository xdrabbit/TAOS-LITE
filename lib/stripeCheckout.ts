import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";

// ── Why this file exists ────────────────────────────────────────────────────
//
// 2026-08-18 → 2026-11-14: every NEW checkout by four different people stalled
// on Stripe's Link wallet page (checkout.link.com) at "Processing…", and the
// session expired unpaid. A retry on 11-14 did get through, so the path was
// flaky rather than dead: a founder retries, a customer walks.
//
// Both session routes used to omit `payment_method_types`, which hands the
// choice to the Dashboard's payment method configuration. On the live account
// that resolved to `["card","klarna","link","cashapp","amazon_pay"]` — Link
// was in every session we ever created.
//
// Two levers, both sent on every session:
//
//   1. `payment_method_types` — an explicit list (default: card only) takes
//      Link-the-payment-method, Klarna, Cash App and Amazon Pay off the page.
//   2. `wallet_options.link.display = "never"` — Link also rides INSIDE the
//      card form as a wallet ("Link in a card integration"), and a card-only
//      list does not promise that is gone. This parameter is Stripe's
//      documented per-session switch: "The Checkout Session will not display
//      Link as a payment option."
//      https://docs.stripe.com/api/checkout/sessions/create#create_checkout_session-wallet_options-link-display
//
// Re-adding methods needs no deploy: TAOS_CHECKOUT_PAYMENT_METHODS is a comma
// list read per request. Put `link` in it and the wallet switch is left alone
// too, which is the whole pre-fix behaviour back.

const DEFAULT_METHODS = ["card"] as const;

/** The payment methods a checkout page offers. Default: card only. */
export function checkoutPaymentMethods(): string[] {
  const raw = process.env.TAOS_CHECKOUT_PAYMENT_METHODS ?? "";
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const method = part.trim().toLowerCase();
    // Stripe's method names are lowercase snake_case. Anything else is a typo
    // or a stray quote, and it is dropped here rather than sent to the till.
    if (/^[a-z][a-z0-9_]*$/.test(method)) seen.add(method);
  }
  return seen.size > 0 ? [...seen] : [...DEFAULT_METHODS];
}

type CreateParams = Stripe.Checkout.SessionCreateParams;

// stripe-node 16 predates `wallet_options`; the API accepts it regardless of
// what the SDK's types know about.
type WithWallet = CreateParams & { wallet_options?: { link: { display: "auto" | "never" } } };

function describeError(error: unknown): { invalid: boolean; param: string; code: string } {
  const e = (error ?? {}) as { type?: string; param?: string; code?: string };
  return {
    invalid: e.type === "StripeInvalidRequestError" || e.code === "parameter_unknown",
    param: typeof e.param === "string" ? e.param : "",
    code: typeof e.code === "string" ? e.code : "?"
  };
}

/**
 * Create a Checkout Session with the Link wallet kept off the page.
 *
 * The two parameters this adds are the only things between a customer and a
 * 400 at the till that were not there last week, so each is allowed to fail
 * exactly once: if Stripe rejects the request BECAUSE of one of them (an API
 * version that does not know `wallet_options`, a method name in the env var
 * that the account cannot take), it is dropped and the session is retried —
 * down to the exact request this route sent before. Checkout can end up no
 * better than it was; it cannot end up worse. Every step is logged.
 */
export async function createCheckoutSession(
  base: CreateParams
): Promise<Stripe.Checkout.Session> {
  const methods = checkoutPaymentMethods();
  const hideLink = !methods.includes("link");

  const withMethods: CreateParams = {
    ...base,
    payment_method_types: methods as CreateParams["payment_method_types"]
  };
  const full: WithWallet = hideLink
    ? { ...withMethods, wallet_options: { link: { display: "never" } } }
    : withMethods;

  // Most protective first; each later attempt removes one thing we added.
  const attempts: { label: string; owns: string; params: CreateParams }[] = [];
  if (hideLink) attempts.push({ label: "methods+link_never", owns: "wallet_options", params: full });
  attempts.push({ label: "methods", owns: "payment_method_types", params: withMethods });
  attempts.push({ label: "dashboard_default", owns: "", params: base });

  const mode = base.mode ?? "?";
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    try {
      const session = await stripe.checkout.sessions.create(attempt.params);
      console.log(
        `[taos-checkout] mode=${mode} methods=${attempt.label === "dashboard_default" ? "dashboard" : methods.join("+")}` +
          ` link=${attempt.label === "methods+link_never" ? "never" : "auto"} shape=${attempt.label}` +
          ` degraded=${i > 0 ? 1 : 0} session=${session.id ?? "?"} outcome=ok`
      );
      return session;
    } catch (error) {
      const { invalid, param, code } = describeError(error);
      const ours = invalid && attempt.owns !== "" && param.startsWith(attempt.owns);
      console.log(
        `[taos-checkout] mode=${mode} shape=${attempt.label} outcome=error code=${code}` +
          ` param=${param || "-"} retry=${ours ? 1 : 0}`
      );
      // Anything that is not about a parameter we added is a real failure and
      // belongs to the route's own error handling, exactly as before.
      if (!ours) throw error;
    }
  }
  // Unreachable: the last attempt owns nothing, so it returns or throws.
  throw new Error("Checkout failed.");
}
