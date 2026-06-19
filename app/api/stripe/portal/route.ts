import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getUserFromRequest } from "@/lib/authServer";

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

    const origin = req.headers.get("origin") ?? new URL(req.url).origin;
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
