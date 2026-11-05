// Founder translation review (Tom, 2026-11-04). The gate, the knobs, the
// flag vocabulary and the retention arithmetic, in one isomorphic module:
// no node: imports, no browser globals, so the page, the routes, the shell
// and the tests all read one definition. The lib/walkie/flag.ts shape.
//
// ── The gate ───────────────────────────────────────────────────────────────
// FOUNDERS ONLY, no release flag: nothing here is for customers, and nothing
// is stored for anyone until a founder flips their OWN opt-in
// (profiles.review_keep_audio, default off). The page gate runs in the
// browser and only hides the screen; every /api/review route re-asks
// isFounder() against a server-validated session and answers 404 otherwise
// (lib/review/guard.ts).

import { isFounder } from "@/lib/release";

/** May this person reach /review at all? */
export function reviewVisibleTo(email: string | null | undefined): boolean {
  return isFounder(email);
}

// ── What the screen shows, in one pure function ────────────────────────────
// Three answers, not four: there is no "disabled" because there is no flag.
// A signed-in non-founder gets "denied" — the page shows a plain not-found
// card, the same answer the routes give, rather than a "coming soon" advert.
export type ReviewGateState = "loading" | "sign-in" | "denied" | "open";

export function reviewGateState(input: {
  ready: boolean;
  email: string | null | undefined;
  signedIn: boolean;
}): ReviewGateState {
  if (!input.ready) return "loading";
  if (!input.signedIn) return "sign-in";
  return isFounder(input.email) ? "open" : "denied";
}

// ── Retention ──────────────────────────────────────────────────────────────
// Audio and text are review data for 14 days (Tom, 2026-11-04), then gone.
// Stamped on every row as `expires_at` at insert, so a later change to the
// knob never reaches back into what was already promised; the sweep only
// asks "is expires_at in the past?".
export const REVIEW_DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export function reviewRetentionDays(
  raw: string | undefined = process.env.TAOS_REVIEW_RETENTION_DAYS
): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return REVIEW_DEFAULT_RETENTION_DAYS;
  return Math.min(365, n);
}

/** When a turn kept at `createdAtMs` stops existing. */
export function reviewExpiresAt(createdAtMs: number, retentionDays: number): Date {
  return new Date(createdAtMs + retentionDays * DAY_MS);
}

/** Has this row's promise run out? Unparseable counts as expired. */
export function reviewExpired(expiresAt: string, nowMs: number): boolean {
  const at = Date.parse(expiresAt);
  return !Number.isFinite(at) || at <= nowMs;
}

// ── The flag ───────────────────────────────────────────────────────────────
// One tap, four reasons — Tom's question is "did the transcript go wrong or
// the translation?", so the first two name exactly those, in his words.
export const FLAG_REASONS = ["words", "meaning", "tone", "other"] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

export function isFlagReason(raw: unknown): raw is FlagReason {
  return typeof raw === "string" && (FLAG_REASONS as readonly string[]).includes(raw);
}

/** One line. Long enough for the sentence that was actually said. */
export const FLAG_NOTE_MAX = 200;

export function cleanFlagNote(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, FLAG_NOTE_MAX);
}

/** Which surfaces keep audio. Live and Tabletop store nothing today. */
export const REVIEW_SURFACES = ["home", "taokie"] as const;
export type ReviewSurface = (typeof REVIEW_SURFACES)[number];
