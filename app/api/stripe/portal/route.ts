import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getUserFromRequest } from "@/lib/authServer";
import { trustedOrigin } from "@/lib/authRedirect";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: "Billing is not configured yet." }, { status: 500 });
    }
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .maybeSingle();

    const customerId = profile?.stripe_customer_id as string | null;
    if (!customerId) {
      return NextResponse.json({ error: "No billing account yet." }, { status: 400 });
    }

    // Stripe bounces the customer to whatever we put below, so the raw Origin
    // header cannot go in — that is an open redirect with a checkout page in
    // front of it. The `new URL(req.url).origin` fallback is gone with it:
    // req.url's host comes from the same untrusted request, so it was never the
    // safer branch. `fetch` sends Origin on same-origin POSTs too, which is why
    // dropping it costs nothing on prod, previews or localhost.
    const origin = trustedOrigin(req.headers.get("origin"));
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: origin
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Billing portal failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
