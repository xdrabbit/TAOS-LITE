// Tabletop "Interpreter mode" (Tom, 2026-11-09). At dinner he and Liz used
// ChatGPT voice to talk back and forth and want that in TAOS: an AI sitting
// between them that interprets continuously — no record button, no timer —
// and that knows their context.
//
// This file is the gate and the knobs, isomorphic (no node: imports, no
// browser globals) so the page, the routes, the shell and the tests read one
// definition.
//
// ── The gate ───────────────────────────────────────────────────────────────
// FOUNDERS ONLY, behind a SERVER-ONLY flag, on the TAOS_WALKIE_ENABLED /
// TAOS_TABLETOP_AUTO_ENABLED pattern: the page reads the flag on the server
// and hands the shell a boolean; every /api/tabletop/interpreter route reads
// it before anything else and answers 404 with it unset. Nothing about it
// ships in a bundle. Flipping it is a Vercel env edit + redeploy:
//
//     TAOS_INTERPRETER_ENABLED=1
//
// Founder-ness is asked on top, server-side, against a validated session —
// the chip on /tabletop runs in the browser and only HIDES the mode.

import { isFounder } from "@/lib/release";

export function interpreterEnabled(
  raw: string | undefined = process.env.TAOS_INTERPRETER_ENABLED
): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/** May this person reach Interpreter mode at all? Both halves, always. */
export function interpreterVisibleTo(email: string | null | undefined, enabled: boolean): boolean {
  return enabled && isFounder(email);
}

// ── The session cap ────────────────────────────────────────────────────────
// A continuous session has no per-turn button to stop the meter, so it gets a
// hard ceiling. 30 minutes is a dinner; the knob is in MINUTES because that is
// how Tom said it.
//
//     TAOS_INTERPRETER_MAX_MIN=30
//
// The server stamps the cap into the mint response and the client enforces it
// (lib/interpreter/limits.ts) — the same trust shape as every other realtime
// surface here: a minted session is spendable, and the cap on it is ours.
export const INTERPRETER_DEFAULT_MAX_MIN = 30;
const INTERPRETER_MAX_MIN_CEILING = 120;

export function interpreterMaxMinutes(
  raw: string | undefined = process.env.TAOS_INTERPRETER_MAX_MIN
): number {
  const n = Number((raw ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return INTERPRETER_DEFAULT_MAX_MIN;
  return Math.min(INTERPRETER_MAX_MIN_CEILING, Math.max(1, Math.round(n)));
}

// ── The idle stop ──────────────────────────────────────────────────────────
// Nobody has spoken (and the interpreter has not spoken) for this long → the
// session hangs itself up. A phone left on the table after dessert must not
// keep an audio session open until the cap.
//
//     TAOS_INTERPRETER_IDLE_SEC=60
export const INTERPRETER_DEFAULT_IDLE_SEC = 60;

export function interpreterIdleSeconds(
  raw: string | undefined = process.env.TAOS_INTERPRETER_IDLE_SEC
): number {
  const n = Number((raw ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return INTERPRETER_DEFAULT_IDLE_SEC;
  return Math.min(600, Math.max(15, Math.round(n)));
}
