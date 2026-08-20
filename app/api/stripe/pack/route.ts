import { NextRequest, NextResponse } from "next/server";
import { stripe, STRIPE_PACKS } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getUserFromRequest } from "@/lib/authServer";
import { trustedOrigin } from "@/lib/authRedirect";

export const runtime = "nodejs";

// One-time purchase of a tutor-minute pack. Only active subscribers can buy a
// pack — free users should subscribe first (that's the funnel we want).
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: "Billing is not configured yet." }, { status: 500 });
    }
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as { pack?: string };
    const pack = STRIPE_PACKS[body.pack ?? "100"] ?? STRIPE_PACKS["100"];

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id, subscription_status")
      .eq("id", user.id)
      .maybeSingle();

    const status = (profile?.subscription_status as string | undefined) ?? "free";
    if (!(status === "active" || status === "comp")) {
      return NextResponse.json(
        { error: "subscribe_required", details: "Subscribe to a plan before buying add-on packs." },
        { status: 402 }
      );
    }

    let customerId = (profile?.stripe_customer_id as string | null) ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { user_id: user.id }
      });
      customerId = customer.id;
      await supabaseAdmin
        .from("profiles")
        .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
        .eq("id", user.id);
    }

    // Stripe bounces the customer to whatever we put below, so the raw Origin
    // header cannot go in — that is an open redirect with a checkout page in
    // front of it. The `new URL(req.url).origin` fallback is gone with it:
    // req.url's host comes from the same untrusted request, so it was never the
    // safer branch. `fetch` sends Origin on same-origin POSTs too, which is why
    // dropping it costs nothing on prod, previews or localhost.
    const origin = trustedOrigin(req.headers.get("origin"));
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [{ price: pack.price, quantity: 1 }],
      client_reference_id: user.id,
      // The webhook reads these to credit the right number of minutes.
      metadata: { kind: "pack", pack_minutes: String(pack.minutes), user_id: user.id },
      payment_intent_data: {
        metadata: { kind: "pack", pack_minutes: String(pack.minutes), user_id: user.id }
      },
      success_url: `${origin}/tutor?pack=success`,
      cancel_url: `${origin}/tutor?pack=cancel`
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Checkout failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
