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

function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Credit add-on pack minutes to the current month's bonus balance (month-scoped:
// a pack tops up the current month and is superseded next month).
async function creditBonus(userId: string, seconds: number) {
  const period = monthKey();
  const { data: p } = await supabaseAdmin
    .from("profiles")
    .select("bonus_seconds, bonus_period")
    .eq("id", userId)
    .maybeSingle();
  const cur =
    (p?.bonus_period as string | null) === period ? ((p?.bonus_seconds as number | null) ?? 0) : 0;
  await supabaseAdmin
    .from("profiles")
    .update({
      bonus_seconds: cur + seconds,
      bonus_period: period,
      updated_at: new Date().toISOString()
    })
    .eq("id", userId);
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
        // One-time add-on pack purchase → credit bonus minutes.
        if (session.mode === "payment" && session.metadata?.kind === "pack") {
          const minutes = parseInt(session.metadata.pack_minutes ?? "0", 10);
          const userId = (session.client_reference_id ?? session.metadata.user_id) as string | null;
          if (minutes > 0 && userId) await creditBonus(userId, minutes * 60);
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
