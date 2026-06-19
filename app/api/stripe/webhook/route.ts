import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

function periodEndISO(sub: Stripe.Subscription): string | null {
  const end = sub.current_period_end;
  return typeof end === "number" ? new Date(end * 1000).toISOString() : null;
}

async function syncSubscription(sub: Stripe.Subscription, userId?: string | null) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const fields = {
    subscription_status: sub.status, // active | trialing | past_due | canceled | unpaid | ...
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    current_period_end: periodEndISO(sub),
    plan: sub.status === "active" || sub.status === "trialing" ? "pro" : "free",
    updated_at: new Date().toISOString()
  };

  // Prefer the explicit user id from checkout; otherwise match by customer.
  if (userId) {
    await supabaseAdmin.from("profiles").update(fields).eq("id", userId);
  } else {
    await supabaseAdmin.from("profiles").update(fields).eq("stripe_customer_id", customerId);
  }
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
