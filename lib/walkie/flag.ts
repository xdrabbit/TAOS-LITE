// Taokie — the push-to-talk translation walkie (Tom, 2026-11-01). The gate,
// the knobs, and the retention arithmetic, in one isomorphic module: no
// node: imports, no browser globals, so the page, the routes, the shell and
// the tests all read one definition.
//
// ── The gate ───────────────────────────────────────────────────────────────
// FOUNDERS ONLY, behind a SERVER-ONLY flag, on the TAOS_TABLETOP_AUTO_ENABLED
// / TAOS_DEMO_ENABLED pattern (lib/release.ts, lib/demo/server.ts): the page
// reads the flag on the server and hands the shell a boolean; every
// /api/walkie route reads it before anything else and answers 404 with it
// unset. Nothing about it ships in a bundle. Flipping it is a Vercel env edit
// + redeploy:
//
//     TAOS_WALKIE_ENABLED=1
//
// Founder-ness is asked on top, server-side, against a validated session —
// the nav tile and the page gate run in the browser and only HIDE the screen.

import { isFounder } from "@/lib/release";

export function walkieEnabled(raw: string | undefined = process.env.TAOS_WALKIE_ENABLED): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/** May this person reach Taokie at all? Both halves, always. */
export function walkieVisibleTo(email: string | null | undefined, enabled: boolean): boolean {
  return enabled && isFounder(email);
}

// ── What the screen shows, in one pure function ────────────────────────────
// Same four answers as /demo's gate (lib/demo/gate.ts), for the same reason:
// a founder whose phone dropped its session must be one tap from the screen,
// not stranded on "not enabled".
export type WalkieGateState = "disabled" | "loading" | "sign-in" | "denied" | "open";

export function walkieGateState(input: {
  enabled: boolean;
  ready: boolean;
  email: string | null | undefined;
  signedIn: boolean;
}): WalkieGateState {
  if (!input.enabled) return "disabled";
  if (!input.ready) return "loading";
  if (!input.signedIn) return "sign-in";
  return isFounder(input.email) ? "open" : "denied";
}

// ── The turn cap ───────────────────────────────────────────────────────────
// Hold the button longer than this and the turn sends itself. 30 seconds:
// a walkie turn is a sentence or two, and the whole bet is that it feels
// faster than a voice note. The home screen's five minutes would let a
// person deliver a speech into a channel the other phone has locked itself
// out of for the duration. Server-side knob, handed to the shell as a prop.
export const WALKIE_DEFAULT_MAX_TURN_MS = 30_000;
const WALKIE_MIN_CAP_MS = 5_000;
const WALKIE_MAX_CAP_MS = 300_000; // /api/walkie/turn's maxDuration, like /api/translate

export function walkieMaxTurnMs(
  raw: string | undefined = process.env.TAOS_WALKIE_MAX_TURN_MS
): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return WALKIE_DEFAULT_MAX_TURN_MS;
  return Math.min(WALKIE_MAX_CAP_MS, Math.max(WALKIE_MIN_CAP_MS, n));
}

// ── Retention ──────────────────────────────────────────────────────────────
// Audio and text are product data for 30 days (Tom, 2026-11-01), then gone.
// The number is stamped on every row as `expires_at` at insert time, so a
// later change to the knob never reaches back into what was already promised,
// and the sweep (lib/walkie/store.ts, /api/walkie/sweep) only ever asks
// "is expires_at in the past?".
export const WALKIE_DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function walkieRetentionDays(
  raw: string | undefined = process.env.TAOS_WALKIE_RETENTION_DAYS
): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return WALKIE_DEFAULT_RETENTION_DAYS;
  return Math.min(365, n);
}

/** When a message created at `createdAtMs` stops existing. */
export function walkieExpiresAt(createdAtMs: number, retentionDays: number): Date {
  return new Date(createdAtMs + retentionDays * DAY_MS);
}

/** Has this row's promise run out? Unparseable counts as expired. */
export function walkieExpired(expiresAt: string, nowMs: number): boolean {
  const at = Date.parse(expiresAt);
  return !Number.isFinite(at) || at <= nowMs;
}
