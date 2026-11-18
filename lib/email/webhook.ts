// Bounce and complaint events from the provider.
//
// Resend signs webhooks the Svix way. Verified by hand (no dependency):
//
//   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
//   key            = base64-decode(secret without its "whsec_" prefix)
//   signature      = base64(HMAC-SHA256(key, signed content))
//   header         = space-separated "v1,<signature>" entries; any may match
//
// and the timestamp must be within five minutes, so a captured request cannot
// be replayed next week. The RAW body is what is signed — parse after.
//
// Which user it is about: the send tags every email with the user's uuid
// (`uid`), and the event carries the tags back. The provider's email id is
// the fallback (matched against daily_email_prefs.last_message_id). The
// recipient ADDRESS in the payload is never read.

import { createHmac, timingSafeEqual } from "node:crypto";
import { isUuid } from "./token";

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function signWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export function verifyWebhook(input: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: Date;
}): boolean {
  const { secret, id, timestamp, signature, body } = input;
  if (!secret || !id || !timestamp || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  const now = (input.now ?? new Date()).getTime() / 1000;
  if (Math.abs(now - seconds) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signWebhook(secret, id, timestamp, body));
  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface DeliveryEvent {
  kind: "bounce" | "complaint";
  /** From the `uid` tag, when it is a uuid. */
  userId: string | null;
  /** The provider's id for the email. */
  messageId: string | null;
}

/** The two events we act on, or null for everything else. */
export function parseDeliveryEvent(payload: unknown): DeliveryEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const { type, data } = payload as { type?: unknown; data?: unknown };
  const kind = type === "email.bounced" ? "bounce" : type === "email.complained" ? "complaint" : null;
  if (!kind || !data || typeof data !== "object") return null;
  const { tags, email_id } = data as { tags?: unknown; email_id?: unknown };
  let uid: unknown = null;
  if (Array.isArray(tags)) {
    uid = (tags as Array<{ name?: unknown; value?: unknown }>).find((t) => t?.name === "uid")?.value;
  } else if (tags && typeof tags === "object") {
    uid = (tags as Record<string, unknown>).uid;
  }
  return {
    kind,
    userId: isUuid(uid) ? uid : null,
    messageId: typeof email_id === "string" && email_id.length <= 100 ? email_id : null
  };
}
