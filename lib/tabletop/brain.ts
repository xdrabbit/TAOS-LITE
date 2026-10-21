// Which realtime "brain" turns a /tabletop turn into text: the A/B Tom asked
// for on 2026-10-21. Two implementations of one small contract —
//
//   openai   today's code, lib/tabletop/live.ts, wrapped and NOT changed: the
//            control arm of the comparison (lib/tabletop/openaiBrain.ts)
//   gemini   Gemini Live Translate, re-aimed from the /call spike
//            (lib/tabletop/geminiBrain.ts)
//
// Either way the readout is the same: the turn's text goes to /api/tts at turn
// end, in Liz's and Tom's cloned voices. Only the brain moves.
//
// ── Who gets to choose ─────────────────────────────────────────────────────
// Founders, and nobody else. Everyone else is locked to openai — not
// defaulted, LOCKED: neither the env default nor a stored choice reaches them,
// so a customer's Tabletop is exactly today's whatever this file is told.

import type { TabletopDirection } from "./instructions";
import type { TabletopLiveState, TurnResult } from "./live";
import type { SegmentTiming, TabletopBrainKind } from "./metrics";

export type { TabletopBrainKind } from "./metrics";

export const TABLETOP_BRAINS: readonly TabletopBrainKind[] = ["openai", "gemini"];

/** Per-device founder choice. */
export const BRAIN_STORAGE_KEY = "taos.tabletop.brain";

export function parseBrain(raw: unknown): TabletopBrainKind | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v === "openai" || v === "gemini" ? v : null;
}

/**
 * The deployment's default for founders: TAOS_TABLETOP_BRAIN=openai|gemini.
 * Anything else — unset, a typo — is openai.
 */
export function brainEnvDefault(raw: string | undefined = process.env.TAOS_TABLETOP_BRAIN): TabletopBrainKind {
  return parseBrain(raw) ?? "openai";
}

/**
 * THE selection rule. A founder's stored per-device choice wins, then the
 * env default; a non-founder gets openai, full stop.
 */
export function resolveBrain(opts: {
  founder: boolean;
  stored: unknown;
  envDefault: TabletopBrainKind;
}): TabletopBrainKind {
  if (!opts.founder) return "openai";
  return parseBrain(opts.stored) ?? opts.envDefault;
}

/** What a brain tells the table while it works. */
export interface TabletopBrainEvents {
  onState?: (s: TabletopLiveState) => void;
  onError?: (msg: string) => void;
  /** Running transcript of what the mic heard this turn (speaker's language). */
  onHeard?: (text: string) => void;
  /** Streaming chunk of translated text for the current turn. */
  onPartial?: (delta: string) => void;
  /** One segment's translation finished, with how long it took. */
  onSegmentDone?: (text: string, meta: SegmentTiming | null) => void;
  /** The brain had to reopen its connection mid-session, unplanned. */
  onReconnect?: () => void;
  /** Running estimate of what this session has spent on the BRAIN (not TTS). */
  onSpend?: (usd: number) => void;
}

export interface ActiveTabletopBrain {
  kind: TabletopBrainKind;
  /** Point the brain at a direction and open the mic. False = not ready. */
  beginTurn: (direction: TabletopDirection) => boolean;
  /** Close the mic, wait for in-flight phrases, resolve the whole turn. */
  endTurn: () => Promise<TurnResult>;
  stop: () => void;
}

export type StartTabletopBrain = (
  events: TabletopBrainEvents,
  openingDirection: TabletopDirection
) => Promise<ActiveTabletopBrain>;
