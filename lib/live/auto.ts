// /live's two-way mode (Tom and Liz, 2026-11-17): one phone between two
// people, nobody sets a direction. Each heard segment is in ONE of the pair's
// two languages and is rendered into the OTHER.
//
// Almost nothing here is new machinery, on purpose:
//
//   · which language was written is read from the `[xx]` tag the tabletop's
//     auto-detect already uses (lib/tabletop/autoDetect.ts — the tag stream,
//     and "a miss is not a guess");
//   · one response per heard segment, by `item_reference`, is word-for-word's
//     own plumbing (lib/live/respond.ts) — including the 90-second skip-ahead;
//   · "is that our own voice coming back?" is the interpreter's echoOverlap
//     (lib/interpreter/captionFilter.ts).
//
// What IS decided here:
//
// ── Auto is word for word, only ────────────────────────────────────────────
// Summary answers ONE bare `response.create` with a single micro-summary of
// everything that piled up — and at a two-person table "everything that piled
// up" is routinely one remark in each language. There is no "other language"
// to render a mixed pile into, and a single tag cannot describe it. A summary
// of each segment on its own would be a second, lossier word-for-word. So Auto
// runs word-for-word whatever the style chip says, the Summary chip says why,
// and the stored style is left alone for when Auto goes off again.
//
// ── Auto writes; it does not speak unless asked ────────────────────────────
// The tag has to be the first thing the model produces, and a model that
// produces AUDIO would say it aloud. So an Auto session is minted text-only
// (lib/live/session.ts), exactly like the table. That also settles the echo
// question by default: a phone that is not speaking cannot hear itself.
// Voice is a separate toggle, OFF every time Auto is switched on; turned on,
// each line is read through /api/tts and the mic is held shut while it plays
// (createLiveEchoGate below) with the transcript check behind it as a second
// fence (createEchoGuard).
//
// Pure and dependency-light: the shell, the WebRTC client and the tests all
// import this, and two of those run in the browser.

import { createHalfDuplex, HALF_DUPLEX_TAIL_MS } from "@/lib/interpreter/halfDuplex";
import { echoOverlap, ECHO_OVERLAP } from "@/lib/interpreter/captionFilter";
import type { LiveStyle } from "@/lib/live/style";

/** Per device, like the style. Off unless this device turned it on. */
export const LIVE_AUTO_STORAGE_KEY = "taos.live.auto";

/** Only the exact stored "1" is on. Anything else is today's one-direction /live. */
export function resolveLiveAuto(value: unknown): boolean {
  return value === "1" || value === true;
}

// Storage lives here and not in components/LiveShell.tsx for the reason
// lib/live/style.ts gives: tests/release.test.ts forbids the shell from
// touching storage at all.
export function readStoredLiveAuto(): boolean {
  try {
    return resolveLiveAuto(window.localStorage.getItem(LIVE_AUTO_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function storeLiveAuto(on: boolean): void {
  try {
    window.localStorage.setItem(LIVE_AUTO_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* the choice still holds for this visit */
  }
}

/** The style a session actually runs in. Auto is word-for-word, whatever the chip says. */
export function effectiveLiveStyle(style: LiveStyle, auto: boolean): LiveStyle {
  return auto ? "verbatim" : style;
}

/**
 * One finished line of /live: what was heard and what it was rendered as.
 *
 * In Auto both languages come from the tag — the tag names what was WRITTEN,
 * so what was heard is the other end of the pair. On a miss both are null:
 * the words are shown, the direction is not guessed (`detect: "miss"`).
 * Outside Auto the direction is the session's own and `detect` is null.
 */
export interface LiveLine {
  /** Order within this session, from 1. */
  seq: number;
  heard: string;
  heardLang: string | null;
  text: string;
  textLang: string | null;
  detect: "hit" | "miss" | null;
}

/** The other end of a pair, or null for a code that is not in it. */
export function otherOfPair(pair: readonly [string, string], code: string): string | null {
  if (code === pair[0]) return pair[1];
  if (code === pair[1]) return pair[0];
  return null;
}

// ── Echo, fence one: the mic is shut while we speak ────────────────────────

/**
 * Half-duplex for Auto's optional voice, on the interpreter's own rule
 * (lib/interpreter/halfDuplex.ts): while our readout is audible, and for the
 * same 300 ms tail after it, the microphone is sent as silence. Silence, not a
 * gap — over WebRTC that is `track.enabled = false`, the stream stays
 * continuous and server VAD closes any turn it had open.
 *
 * `speakStart` is called when a readout begins to play and `speakEnd` when it
 * ends (or is cut). The gate decides; `setMicHeld` is the only side effect.
 */
export interface LiveEchoGate {
  speakStart: () => void;
  speakEnd: () => void;
  /** Is the mic shut right now? */
  held: () => boolean;
  /** Drop any pending re-open timer (session over). Leaves the mic open. */
  dispose: () => void;
}

/** A readout never plays longer than this; if "ended" is lost the mic comes back. */
export const LIVE_READOUT_MAX_MS = 90_000;

export function createLiveEchoGate(deps: {
  setMicHeld: (held: boolean) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  tailMs?: number;
}): LiveEchoGate {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const tailMs = deps.tailMs ?? HALF_DUPLEX_TAIL_MS;
  const duplex = createHalfDuplex(tailMs);
  let timer: unknown = null;
  let isHeld = false;

  const apply = () => {
    const want = duplex.micMuted(now());
    if (want !== isHeld) {
      isHeld = want;
      deps.setMicHeld(want);
    }
  };
  const rearm = (ms: number) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      apply();
    }, ms);
  };

  return {
    speakStart: () => {
      duplex.playing(0, now() + LIVE_READOUT_MAX_MS);
      apply();
      // If the element never reports the end, the mic is not lost for good.
      rearm(LIVE_READOUT_MAX_MS + tailMs + 1);
    },
    speakEnd: () => {
      duplex.cut(0, now());
      apply();
      rearm(tailMs + 1);
    },
    held: () => isHeld,
    dispose: () => {
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (isHeld) {
        isHeld = false;
        deps.setMicHeld(false);
      }
    }
  };
}

// ── Echo, fence two: a heard line that is what we just said ────────────────

/** How long after a readout its words are still suspect when heard back. */
export const LIVE_ECHO_WINDOW_MS = 20_000;

/**
 * Remembers what this phone SPOKE and answers "is this heard segment that,
 * coming back?". Only spoken lines are remembered, so with voice off this can
 * never drop anything. The measure is the interpreter's: the share of the
 * heard words that are in the spoken line, 0.6 and up is a repetition
 * (ECHO_OVERLAP). A real reply shares names, numbers and the odd cognate with
 * the line before it; our own voice shares nearly all of it.
 *
 * It errs toward dropping: somebody who reads the translation aloud off the
 * screen within the window is dropped too. That is counted and shown on the
 * screen ("own voice ignored"), never silent — and the alternative failure is
 * the one this feature may not ship with, a phone translating itself in a
 * loop.
 */
export function createEchoGuard(windowMs: number = LIVE_ECHO_WINDOW_MS) {
  let spoken: Array<{ text: string; until: number }> = [];
  return {
    /** A readout of `text` started (or is still audible) at `now`. */
    spoke(text: string, now: number): void {
      spoken = spoken.filter((s) => s.until > now);
      spoken.push({ text, until: now + windowMs });
      if (spoken.length > 8) spoken = spoken.slice(-8);
    },
    /** Extend the window from when a readout actually finished. */
    finished(text: string, now: number): void {
      for (const s of spoken) if (s.text === text) s.until = Math.max(s.until, now + windowMs);
    },
    isEcho(heard: string, now: number): boolean {
      spoken = spoken.filter((s) => s.until > now);
      // Two words can match anything by accident ("Sí, claro").
      const words = heard.match(/[\p{L}\p{N}]+/gu) ?? [];
      if (words.length < 3) return false;
      return spoken.some((s) => echoOverlap(heard, s.text) >= ECHO_OVERLAP);
    },
    clear(): void {
      spoken = [];
    }
  };
}
