import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Meta's `X-Hub-Signature-256` header on a webhook delivery.
 *
 * The header is `sha256=` + hex(HMAC-SHA256(appSecret, rawBody)). The raw
 * body must be the exact bytes Meta signed — verify BEFORE JSON.parse, and
 * read it only once (the stream is consumed).
 *
 * Pure function, no Next.js imports, so the webhook's auth is unit-testable —
 * see tests/whatsapp-webhook.test.ts. Same discipline as the Stripe webhook:
 * an unverifiable delivery is rejected, never processed.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const expected =
    "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
