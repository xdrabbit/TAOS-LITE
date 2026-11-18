import { NextRequest, NextResponse } from "next/server";
import { supabasePrefsStore } from "@/lib/email/store";
import { parseDeliveryEvent, verifyWebhook } from "@/lib/email/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/email/webhook — the provider telling us an email bounced or was
// marked as spam (lib/email/webhook.ts has the signature scheme).
//
//   bounce    → `bounced` on the row. That address is never mailed again, and
//               the toggle cannot turn it back on.
//   complaint → treated as an unsubscribe. Somebody who pressed "spam" has
//               said no more clearly than the footer link lets them.
//
// Signature first, on the RAW body, before anything is parsed. Without
// RESEND_WEBHOOK_SECRET nothing can be verified, so nothing is accepted: 503,
// and the provider retries later — by which time the secret may be set.
//
// The log line carries a uuid and an outcome. The payload has the recipient's
// address in it; this route never reads that field.

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = (process.env.RESEND_WEBHOOK_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "Not configured" }, { status: 503 });

  const body = await req.text();
  const ok = verifyWebhook({
    secret,
    id: req.headers.get("svix-id"),
    timestamp: req.headers.get("svix-timestamp"),
    signature: req.headers.get("svix-signature"),
    body
  });
  if (!ok) return NextResponse.json({ error: "Bad signature" }, { status: 401 });

  let payload: unknown = null;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const event = parseDeliveryEvent(payload);
  // Every other event type is acknowledged and ignored.
  if (!event) return NextResponse.json({ ok: true, handled: false });

  const userId = event.userId ?? (event.messageId ? await supabasePrefsStore.userForMessage(event.messageId) : null);
  if (!userId) {
    console.log(`[taos-daily-email] webhook kind=${event.kind} outcome=no_user`);
    return NextResponse.json({ ok: true, handled: false });
  }
  const done =
    event.kind === "bounce" ? await supabasePrefsStore.flagBounce(userId) : await supabasePrefsStore.unsubscribe(userId);
  console.log(`[taos-daily-email] webhook kind=${event.kind} user=${userId} outcome=${done ? "flagged" : "no_row"}`);
  return NextResponse.json({ ok: true, handled: done });
}
