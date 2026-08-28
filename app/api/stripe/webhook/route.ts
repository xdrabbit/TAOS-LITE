import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe, tierForPrice } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

function periodEndISO(sub: Stripe.Subscription): string | null {
  // The account's API version (2026-05-27.dahlia) carries the billing window on
  // the subscription *item*; the top-level field is gone, so reading it stored a
  // null current_period_end on every sync. Item first, top-level as the fallback
  // for older versions.
  const item = sub.items?.data?.[0] as { current_period_end?: number } | undefined;
  const end =
    item?.current_period_end ??
    (sub as Stripe.Subscription & { current_period_end?: number }).current_period_end;
  return typeof end === "number" ? new Date(end * 1000).toISOString() : null;
}

async function syncSubscription(sub: Stripe.Subscription, userId?: string | null) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const active = sub.status === "active" || sub.status === "trialing";
  // Which plan they bought, from the subscription's price → our tier label.
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  const tier = active ? tierForPrice(priceId) : null;
  const fields: Record<string, unknown> = {
    subscription_status: sub.status, // active | trialing | past_due | canceled | unpaid | ...
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    current_period_end: periodEndISO(sub),
    plan: active ? "pro" : "free",
    tier, // 'basic' | 'premium' | null
    updated_at: new Date().toISOString()
  };

  // Prefer the explicit user id from checkout; otherwise match by customer.
  if (userId) {
    await supabaseAdmin.from("profiles").update(fields).eq("id", userId);
  } else {
    await supabaseAdmin.from("profiles").update(fields).eq("stripe_customer_id", customerId);
  }
}

// Stripe delivers events concurrently and with no ordering guarantee, and each
// event carries the object as it looked when the event was *created*. The
// `customer.subscription.created` snapshot says `status: "incomplete"` — it is
// minted before the card is charged — so when it is processed after
// `checkout.session.completed`, writing that snapshot puts a customer who just
// paid back on the free plan. That is exactly what the first live purchase did
// (2026-08-23: $19.99 charged, profile left at plan=free, tier=null).
//
// Re-reading the subscription from Stripe makes every handler write current
// truth regardless of arrival order, so a late event is a redundant write
// instead of a downgrade.
async function reReadSubscription(snapshot: Stripe.Subscription): Promise<Stripe.Subscription> {
  try {
    return await stripe.subscriptions.retrieve(snapshot.id);
  } catch {
    // If the re-read fails, the snapshot is still better than nothing.
    return snapshot;
  }
}

// ── Add-on minute packs ─────────────────────────────────────────────────────
//
// Two things changed here in tutor phase 2, and both of them are about a pack
// being a PURCHASE rather than a subscription:
//
//   1. The credit is PERSISTENT. It used to land on `bonus_seconds` +
//      `bonus_period`, scoped to the calendar month it was bought in — which
//      meant a $9.99 pack bought on the 30th was mostly a donation. It now
//      lands on `profiles.pack_seconds`, which rolls over and never expires.
//      Plan minutes still reset monthly; lib/tutor/meter.ts spends the plan
//      first so the rented minutes go before the bought ones.
//
//   2. It is REPLAY-SAFE. Stripe redelivers `checkout.session.completed` on
//      any non-2xx, on a manual resend from the dashboard, and after a timeout
//      it decided about on its own — and this handler already answers
//      `{ received: true, handled: false }` (a 200) on a processing hiccup,
//      which means a retry that succeeds the second time would have credited
//      twice under a read-add-write. `stripe_pack_credits` makes the checkout
//      session id the idempotency key: the insert is attempted FIRST, and a
//      primary-key conflict means these minutes are already on the balance.
//
// The PR #29 rule applies as it does everywhere else on this route: never bill
// off the event's snapshot. The session is re-read from Stripe, and the credit
// only happens if Stripe currently says it was paid.

async function creditPack(
  checkoutSessionId: string,
  userId: string,
  seconds: number
): Promise<boolean> {
  // Claim first. If this conflicts, another delivery of the same event already
  // paid these minutes out and there is nothing to do.
  const { error } = await supabaseAdmin
    .from("stripe_pack_credits")
    .insert({ checkout_session_id: checkoutSessionId, user_id: userId, seconds });
  if (error) {
    // 23505 = unique_violation: the expected, boring case on a redelivery.
    // Anything else means the claim itself failed, and crediting without a
    // claim is how a $9.99 pack becomes an unbounded one.
    // eslint-disable-next-line no-console
    console.log(`taos.stripe.pack skip · ${checkoutSessionId} · ${error.code ?? "?"}`);
    return false;
  }

  const { data: p } = await supabaseAdmin
    .from("profiles")
    .select("pack_seconds")
    .eq("id", userId)
    .maybeSingle();
  const current = (p?.pack_seconds as number | null) ?? 0;
  await supabaseAdmin
    .from("profiles")
    .update({ pack_seconds: current + seconds, updated_at: new Date().toISOString() })
    .eq("id", userId);
  // eslint-disable-next-line no-console
  console.log(
    `taos.stripe.pack credit · ${checkoutSessionId} · user=${userId} · +${seconds}s · balance=${current + seconds}s`
  );
  return true;
}

// Never trust the event's snapshot — same rule as reReadSubscription. A
// checkout session's `payment_status` at event time can still be `unpaid` for
// the asynchronous payment methods, and a pack credited off that snapshot is
// minutes given away for a charge that never landed.
async function reReadCheckoutSession(
  snapshot: Stripe.Checkout.Session
): Promise<Stripe.Checkout.Session> {
  try {
    return await stripe.checkout.sessions.retrieve(snapshot.id);
  } catch {
    return snapshot;
  }
}

async function handlePackPurchase(snapshot: Stripe.Checkout.Session): Promise<void> {
  const session = await reReadCheckoutSession(snapshot);
  if (session.payment_status !== "paid") {
    // eslint-disable-next-line no-console
    console.log(`taos.stripe.pack unpaid · ${session.id} · ${session.payment_status}`);
    return;
  }
  const minutes = parseInt(session.metadata?.pack_minutes ?? "0", 10);
  const userId = (session.client_reference_id ?? session.metadata?.user_id) as string | null;
  if (!(minutes > 0) || !userId) return;
  await creditPack(session.id, userId, minutes * 60);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });
  }

  const signature = req.headers.get("stripe-signature") ?? "";
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        // One-time add-on pack purchase → credit persistent pack minutes.
        if (session.mode === "payment" && session.metadata?.kind === "pack") {
          await handlePackPurchase(session);
          break;
        }
        const subId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          await syncSubscription(sub, session.client_reference_id);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // Never trust the event's snapshot — see reReadSubscription.
        const snapshot = event.data.object as Stripe.Subscription;
        await syncSubscription(await reReadSubscription(snapshot));
        break;
      }
      default:
        break;
    }
  } catch {
    // Don't 500 on a processing hiccup — Stripe would retry forever. Log-and-ack.
    return NextResponse.json({ received: true, handled: false });
  }

  return NextResponse.json({ received: true });
}
