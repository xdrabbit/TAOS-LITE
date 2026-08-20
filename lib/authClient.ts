// The browser half of the spend fence (lib/spendGuard.ts).
//
// Every route that costs money now wants `Authorization: Bearer <access
// token>`, and before 8/19 not one of the screens sent it — the money routes
// took no identity at all, so there was nothing to send it to. Rather than
// paste the same four lines of `supabase.auth.getSession()` into six call
// sites, they all come here.
//
// Two shapes because the callers genuinely differ: /api/translate posts
// FormData (the browser must set its own multipart boundary, so a
// Content-Type here would corrupt the body) while the JSON routes need one.

import { supabase } from "./supabase";

/**
 * `Authorization` for the current session, or `{}` when signed out.
 *
 * Empty rather than throwing on purpose: the two routes on the /try funnel
 * accept an anonymous caller, and a screen that is merely PRE-session (the
 * shells read the session asynchronously on mount) should send the request and
 * get an honest 401 back, not blow up locally with a different error.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The same, plus the JSON content type the non-FormData routes need. */
export async function jsonAuthHeaders(): Promise<Record<string, string>> {
  return { "Content-Type": "application/json", ...(await authHeaders()) };
}
