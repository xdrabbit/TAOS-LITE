// What counts as a lead — kept pure so it can be fenced (tests/leads.test.ts),
// same reason chatInvite and chatVoice live outside their routes.
//
// ── Why this file exists ───────────────────────────────────────────────────
// `taos_leads` was world-writable. Its only policy was INSERT for {anon,
// authenticated} `with check (true)`, and the key that satisfies "anon" ships
// in every browser bundle by design — so the table's actual access rule was
// "anyone, anything". Confirmed against production with a real request before
// it was closed: POST with the publishable key and `Prefer: return=minimal`
// answered 201 Created. (With `return=representation` it answers 401, because
// there is no SELECT policy to read the row back — a refusal about the ECHO
// that reads exactly like a refusal about the write. That near-miss is why
// the probe is written down here.)
//
// `docs/data-map.md` (2026-08-26) flagged it, the policy is gone
// (supabase/migrations/20260826_leads_server_only.sql), and POST /api/leads is
// the replacement: validated, rate limited, written with the service role.
// The rules a lead has to satisfy live here rather than in the route, because
// a `with check` constraint could never have expressed them and a route is
// not a thing a test can call cheaply.
//
// The bar is deliberately LOW. This is a mailing-list signup, not an account:
// the cost of rejecting a real address somebody typed correctly is a lost
// customer, and the cost of accepting a junk one is a row. So these checks
// exist to stop garbage and abuse — prose in an email column, a megabyte of
// body, a script hammering the endpoint — and not to adjudicate whether an
// address is deliverable. Only sending mail to it can decide that.

/** RFC 5321's ceiling on an address. Anything longer is not a typo. */
export const LEAD_EMAIL_MAX = 254;

/** Longest `source` tag accepted. It is a label, not a message. */
export const LEAD_SOURCE_MAX = 40;

/** Where a lead came from when the caller does not say. */
export const LEAD_SOURCE_DEFAULT = "web";

/**
 * Trim and lowercase.
 *
 * Lowercasing the whole address is technically lossy — the local part is
 * case-SENSITIVE per RFC 5321, so `Tom@` and `tom@` are two mailboxes to a
 * pedantic server. No mail provider anyone will sign up with treats them
 * differently, and folding case is what makes "did this person already sign
 * up?" answerable. The lossy direction is the useful one here.
 */
export function normalizeLeadEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/**
 * Does this look like an address?
 *
 * One `@`, something before it, a dotted something after it, and no
 * whitespace — the shape check, not a validator. Deliberately NOT the
 * famously enormous RFC 5322 regex: that thing accepts addresses no provider
 * will issue and rejects ones people really have, and every minute spent
 * tuning it is a minute not spent sending the confirmation email that
 * actually proves an address exists.
 */
export function isValidLeadEmail(email: string): boolean {
  if (!email || email.length > LEAD_EMAIL_MAX) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}

/**
 * The campaign tag, reduced to something safe to put in a column and read
 * back on a dashboard.
 *
 * Lowercase letters, digits, dash and underscore; everything else is dropped
 * rather than rejected, so a caller that sends "Landing Page!" gets
 * "landingpage" instead of a 400 it cannot act on. An empty result falls back
 * to the default — an unlabelled lead is still a lead, and losing one over a
 * tag would be absurd.
 */
export function normalizeLeadSource(raw: unknown): string {
  const cleaned =
    typeof raw === "string"
      ? raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, LEAD_SOURCE_MAX)
      : "";
  return cleaned || LEAD_SOURCE_DEFAULT;
}

/** What the route answers on a bad address. Not bilingual: this is an API. */
export const LEAD_BAD_EMAIL = "That email address doesn't look right.";

/** What the route answers when the rate limit trips. */
export const LEAD_RATE_LIMITED = "Too many signups from here. Try again later.";

/** What the route answers when it worked. Said once, in both languages. */
export const LEAD_THANKS = "Thanks — you're on the list. · Gracias — estás en la lista.";
