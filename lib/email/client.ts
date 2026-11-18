"use client";

// The browser's half of the daily reminder: one fetch shape, and the source
// marker that says "this visit came from the email".
//
// THE MARKER HAS TO SURVIVE SIGN-IN. The email's button is
// /study?src=daily-email. A signed-out person is bounced through Google and
// comes back to the PATH only — Supabase returns to /study with its own
// ?code= and our query string is gone (the Taokie invite lost its code to
// exactly this on 2026-11-02, which is why invites became a path). The page
// they land on is already carried by SignIn's redirectPath; the marker rides
// in sessionStorage, which lives through a same-tab round trip. It is read
// once, sent with the visit, and removed — and taken off the URL too, so a
// reload does not count a second open.

import { jsonAuthHeaders } from "@/lib/authClient";
import { EMAIL_SOURCE } from "./config";
import type { PrefsPayload } from "./prefsApi";

const SOURCE_KEY = "taos.email.src";

/** Call on mount, BEFORE the sign-in gate. Safe anywhere, any number of times. */
export function rememberEmailSource(): void {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("src") !== EMAIL_SOURCE) return;
    window.sessionStorage.setItem(SOURCE_KEY, EMAIL_SOURCE);
    url.searchParams.delete("src");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* private mode: the open goes uncounted, the page still opens */
  }
}

/** The marker, once. Null when this visit did not come from the email. */
export function takeEmailSource(): string | null {
  try {
    const value = window.sessionStorage.getItem(SOURCE_KEY);
    if (value) window.sessionStorage.removeItem(SOURCE_KEY);
    return value === EMAIL_SOURCE ? value : null;
  } catch {
    return null;
  }
}

/** POST to /api/email/prefs as the signed-in user. Any failure reads as "not available". */
export async function postPrefs(body: Record<string, unknown>): Promise<PrefsPayload> {
  try {
    const headers = await jsonAuthHeaders();
    if (!("Authorization" in headers)) return { available: false };
    const res = await fetch("/api/email/prefs", { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) return { available: false };
    const payload = (await res.json()) as PrefsPayload;
    return payload && payload.available === true && payload.prefs ? payload : { available: false };
  } catch {
    return { available: false };
  }
}
