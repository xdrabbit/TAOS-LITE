import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe, tierForPrice } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

function periodEndISO(sub: Stripe.Subscription): string | null {
  const end = sub.current_period_end;
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
        await syncSubscription(event.data.object as Stripe.Subscription);
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
