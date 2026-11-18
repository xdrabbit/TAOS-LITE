// The signature on an unsubscribe link.
//
// The link in every email is /api/email/unsubscribe?u=<user uuid>&s=<sig>,
// and it has to work signed-out, from a mail client, a year later. So:
//
//   sig = HMAC-SHA256(TAOS_EMAIL_LINK_SECRET, "unsub:" + user id + ":" + row token)
//
// The ROW TOKEN (daily_email_prefs.unsubscribe_token, random per user) never
// leaves the server. It is there so one person's links can be killed by
// rotating one column, and so the env secret alone is not enough to forge a
// link for anyone. A dedicated secret rather than one derived from the Resend
// key (the lib/voz/token.ts trick): rotating a provider key must not break
// the unsubscribe link in mail already sitting in somebody's inbox.

import { createHmac, timingSafeEqual } from "node:crypto";

export function signUnsubscribe(userId: string, rowToken: string, secret: string): string {
  return createHmac("sha256", secret).update(`unsub:${userId}:${rowToken}`).digest("base64url");
}

export function verifyUnsubscribe(userId: string, rowToken: string, secret: string, given: unknown): boolean {
  if (typeof given !== "string" || !given || given.length > 128 || !secret || !rowToken) return false;
  const expected = Buffer.from(signUnsubscribe(userId, rowToken, secret));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function unsubscribeUrl(origin: string, userId: string, rowToken: string, secret: string): string {
  const sig = signUnsubscribe(userId, rowToken, secret);
  return `${origin}/api/email/unsubscribe?u=${encodeURIComponent(userId)}&s=${encodeURIComponent(sig)}`;
}
