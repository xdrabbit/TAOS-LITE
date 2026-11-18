// The email provider, behind the smallest interface that will do.
//
// Everything outside this file talks to `EmailProvider`. Resend is the one
// implementation (Tom, 2026-11-18); swapping it is writing another function
// that returns the same three-field result. No SDK — it is one POST.
//
// Nothing here logs. The caller logs fields only (uuid, outcome); an address
// or a subject must never reach a log line, and the surest way is for the
// code that holds them to have no console call at all.

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  /** ASCII letters, digits, `_` and `-` only (Resend's rule). */
  tags: Record<string, string>;
  /** Same key, same day → the provider sends once however often we ask. */
  idempotencyKey: string;
}

export type SendResult =
  | { ok: true; id: string | null }
  | { ok: false; status: number; retryable: boolean };

export interface EmailProvider {
  name: string;
  send(email: OutgoingEmail): Promise<SendResult>;
}

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function resendProvider(apiKey: string, fetcher: typeof fetch = fetch): EmailProvider {
  return {
    name: "resend",
    async send(email) {
      let res: Response;
      try {
        res = await fetcher(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": email.idempotencyKey
          },
          body: JSON.stringify({
            from: email.from,
            to: [email.to],
            subject: email.subject,
            html: email.html,
            text: email.text,
            headers: email.headers,
            tags: Object.entries(email.tags).map(([name, value]) => ({ name, value }))
          }),
          signal: AbortSignal.timeout(15_000)
        });
      } catch {
        return { ok: false, status: 0, retryable: true };
      }
      if (!res.ok) {
        // 409 = this idempotency key is already in flight or already used:
        // another run has this person's email in hand. Not ours to retry.
        return { ok: false, status: res.status, retryable: res.status === 429 || res.status >= 500 };
      }
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
      return { ok: true, id: typeof body?.id === "string" ? body.id : null };
    }
  };
}
