// Signed tokens for the voice-clone screens (/demo and /voz).
//
// Both screens hand the browser a short string that says "this server made
// this voice for this person, until this time", HMAC-signed with a key
// DERIVED from ELEVENLABS_API_KEY — no new secret, and a leaked token is not
// a leaked key. Each caller passes its own `domain`, so a /demo token can
// never verify as a /voz token and the other way round: the derivation is
// different, not just a field.
//
// Expiry is NOT checked here. Every caller has its own idea of what "late"
// means (a late "Done" must still delete), so readSignedToken only answers
// "did we sign this?".

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function signingKey(domain: string): Buffer | null {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  return createHash("sha256").update(`${domain}:${apiKey}`).digest();
}

function sign(body: string, key: Buffer): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}

/** `base64url(json).signature`. Throws when there is no key to sign with. */
export function mintSignedToken(domain: string, payload: object): string {
  const key = signingKey(domain);
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

/** The parsed payload if the signature is ours for `domain`, else null. */
export function readSignedToken(domain: string, token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string" || token.length > 600) return null;
  const key = signingKey(domain);
  if (!key) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(body, key));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
