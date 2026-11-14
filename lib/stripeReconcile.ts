import type Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// ── Did the money we took turn into the thing we sold? ──────────────────────
//
// The webhook is the only thing that grants an entitlement, and a webhook can
// answer 200 while the profile row stays where it was (2026-08-23 did exactly
// that). This pass asks the question from the other end, once a day: for every
// Checkout Session Stripe calls complete-and-paid in the last 48 hours, is the
// subscription on a profile / the pack on the credits ledger?
//
// LOG ONLY. A gap prints one `[taos-stripe-reconcile]` line of ids and
// changes nothing — no grant, no write, to Stripe or to the database. Granting
// from a sweep is a second fulfillment path on the money route and gets its own
// PR and its own review.
//
// Ids only, as in the webhook: session, subscription, customer, our user uuid.
// The session object carries the buyer's email, name and address under
// `customer_details`; nothing here reads that field.

const TAG = "[taos-stripe-reconcile]";
export const RECONCILE_WINDOW_HOURS = 48;
// A day of this app's checkouts is a handful. The cap is there so a surprise
// (or a test-mode account full of fixtures) cannot turn a daily cron into a
// long walk through Stripe's list API.
const MAX_SESSIONS = 300;

export interface ReconcileResult {
  scanned: number;
  paid: number;
  gaps: number;
  error: string | null;
}

type SessionLike = Pick<
  Stripe.Checkout.Session,
  "id" | "mode" | "status" | "payment_status" | "client_reference_id" | "metadata"
> & { subscription?: string | { id: string } | null; customer?: string | { id: string } | null };

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/** `null` when fulfillment landed; otherwise the one-line reason it did not. */
async function gapFor(session: SessionLike): Promise<string | null> {
  const userId = session.client_reference_id ?? session.metadata?.user_id ?? null;
  const customerId = idOf(session.customer);
  const ids = `session=${session.id} customer=${customerId ?? "-"} user=${userId ?? "-"}`;

  if (session.mode === "payment") {
    if (session.metadata?.kind !== "pack") return null; // not a thing we sell
    const { data, error } = await supabaseAdmin
      .from("stripe_pack_credits")
      .select("checkout_session_id")
      .eq("checkout_session_id", session.id)
      .maybeSingle();
    if (error) return `gap=unknown kind=pack ${ids} reason=db_error`;
    return data ? null : `gap=pack_not_credited kind=pack ${ids} reason=no_credit_row`;
  }

  if (session.mode !== "subscription") return null;
  const subId = idOf(session.subscription);
  if (!userId && !customerId) return `gap=subscription_not_granted kind=subscription ${ids} sub=${subId ?? "-"} reason=no_user_or_customer`;

  const query = supabaseAdmin
    .from("profiles")
    .select("id, plan, subscription_status, stripe_subscription_id");
  const { data, error } = await (userId
    ? query.eq("id", userId)
    : query.eq("stripe_customer_id", customerId as string)
  ).maybeSingle();
  if (error) return `gap=unknown kind=subscription ${ids} sub=${subId ?? "-"} reason=db_error`;
  if (!data) return `gap=subscription_not_granted kind=subscription ${ids} sub=${subId ?? "-"} reason=no_profile`;

  const status = (data.subscription_status as string | null) ?? "none";
  // Landed if the webhook wrote THIS subscription onto the profile (whatever
  // has happened to it since — a cancel is a later event, not a lost grant),
  // or the profile is entitled right now by a newer one.
  const sameSub = Boolean(subId) && data.stripe_subscription_id === subId;
  const entitled = data.plan === "pro" && (status === "active" || status === "trialing");
  if (sameSub || entitled) return null;
  return (
    `gap=subscription_not_granted kind=subscription ${ids} sub=${subId ?? "-"}` +
    ` reason=profile_not_synced profile_status=${status.replace(/[^a-z_]/g, "")}`
  );
}

export async function reconcileCheckouts(
  now: number = Date.now()
): Promise<ReconcileResult> {
  const result: ReconcileResult = { scanned: 0, paid: 0, gaps: 0, error: null };
  if (!process.env.STRIPE_SECRET_KEY) {
    result.error = "no_stripe_key";
    console.log(`${TAG} window_h=${RECONCILE_WINDOW_HOURS} scanned=0 paid=0 gaps=0 err=no_stripe_key`);
    return result;
  }

  try {
    // Imported here, not at the top: the sweep route that calls this is loaded
    // by deployments (and tests) with no Stripe key at all.
    const { stripe } = await import("@/lib/stripe");
    const since = Math.floor(now / 1000) - RECONCILE_WINDOW_HOURS * 3600;
    let startingAfter: string | undefined;
    for (;;) {
      const page = await stripe.checkout.sessions.list({
        created: { gte: since },
        status: "complete",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {})
      });
      for (const session of page.data as SessionLike[]) {
        result.scanned += 1;
        // `complete` + `unpaid` is an async method still settling; the webhook
        // refuses to fulfil that too.
        if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") continue;
        result.paid += 1;
        const gap = await gapFor(session);
        if (gap) {
          result.gaps += 1;
          console.log(`${TAG} ${gap}`);
        }
      }
      const last = page.data[page.data.length - 1];
      if (!page.has_more || !last || result.scanned >= MAX_SESSIONS) break;
      startingAfter = last.id;
    }
  } catch (error) {
    const e = (error ?? {}) as { code?: unknown; type?: unknown; name?: unknown };
    const pick = [e.code, e.type, e.name].find((v) => typeof v === "string" && v);
    result.error = typeof pick === "string" ? pick.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) : "threw";
  }

  console.log(
    `${TAG} window_h=${RECONCILE_WINDOW_HOURS} scanned=${result.scanned} paid=${result.paid}` +
      ` gaps=${result.gaps} err=${result.error ?? "-"}`
  );
  return result;
}
