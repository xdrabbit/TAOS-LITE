import { NextRequest, NextResponse } from "next/server";
import { verifyMetaSignature } from "@/lib/whatsapp/signature";
import { extractInboundMessages } from "@/lib/whatsapp/inbound";
import { handleTextMessage, handleVoiceNote } from "@/lib/whatsapp/voiceNotes";

export const runtime = "nodejs";
// The full turn (download → transcribe → translate → TTS → transcode →
// upload → send) runs inside this function before the 200 goes back to Meta.
// 120s is generous for a voice-note turn; if Meta times out first and
// redelivers, the wamid dedupe below makes the retry a no-op.
export const maxDuration = 120;

/**
 * Redelivery dedupe, keyed by wamid. Meta retries a delivery on any non-2xx
 * or timeout, and without this a slow turn would translate twice and bill
 * twice.
 *
 * In-memory is per-instance: it covers the retry storm from ONE slow turn,
 * which is the case that actually happens. The durable version is a
 * `whatsapp_processed_messages(message_id PK)` table with claim-first
 * insert — the same pattern as stripe_pack_credits. Do that before this
 * number goes public.
 */
const seenMessageIds = new Set<string>();

function alreadySeen(messageId: string): boolean {
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.add(messageId);
  // Bounded: a Set that only grows is a slow leak on a long-lived instance.
  if (seenMessageIds.size > 5000) {
    const oldest = seenMessageIds.values().next();
    if (!oldest.done) seenMessageIds.delete(oldest.value);
  }
  return false;
}

/**
 * Meta's webhook verification: GET with hub.mode=subscribe,
 * hub.verify_token=<what you chose>, hub.challenge=<echo this back>.
 * Answered as plain text, not JSON.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const params = req.nextUrl.searchParams;
  if (
    verifyToken &&
    params.get("hub.mode") === "subscribe" &&
    params.get("hub.verify_token") === verifyToken
  ) {
    return new NextResponse(params.get("hub.challenge") ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
  }
  return NextResponse.json({ error: "Verification failed." }, { status: 403 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Verify FIRST, on the raw bytes, before JSON.parse — same discipline as
  // the Stripe webhook. An unverifiable delivery is rejected, never processed.
  const rawBody = await req.text();
  if (
    !verifyMetaSignature(
      rawBody,
      req.headers.get("x-hub-signature-256"),
      process.env.WHATSAPP_APP_SECRET ?? ""
    )
  ) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  try {
    const { audio, text } = extractInboundMessages(JSON.parse(rawBody) as unknown);
    for (const m of audio) {
      if (alreadySeen(m.messageId)) {
        // eslint-disable-next-line no-console
        console.log(`[taos.whatsapp] redelivery skip · msg=${m.messageId}`);
        continue;
      }
      // Per-message catch: one bad voice note must not starve the rest of
      // the batch. handleVoiceNote itself never throws, this is the belt.
      await handleVoiceNote(m.from, m.messageId, m.mediaId).catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.log(
          `[taos.whatsapp] handler threw · msg=${m.messageId} · ${error instanceof Error ? error.message : error}`
        );
      });
    }
    for (const m of text) {
      if (alreadySeen(m.messageId)) continue;
      await handleTextMessage(m.from, m.messageId).catch(() => {});
    }
  } catch {
    // Log-and-ack, like the Stripe route: a 500 here makes Meta retry
    // forever, and the work is idempotent anyway.
    // eslint-disable-next-line no-console
    console.log("[taos.whatsapp] webhook processing hiccup — acked anyway.");
  }

  return NextResponse.json({ received: true });
}
