// What a finger on a /tabletop pane means (field test, 2026-10-28).
//
// With auto-detect on, Tom tapped a pane out of habit instead of the
// ◉ Auto-detect button, and a side tap was the escape hatch: the whole run
// was a forced turn and the auto prompt never got one. A pharmacy tech will
// tap whatever is in front of her, so with auto on EVERY tap is an auto turn,
// and forcing a direction moves to a long-press on the side that speaks.
//
// Pure — no DOM, no React — so the rules the tests pin are the rules the
// shell runs. Timers are injected for the same reason.

/** Who may be mid-turn, as the pane sees it. */
export type PaneTurn<S extends string = string> =
  | { kind: "idle" }
  | { kind: "connecting" | "recording" | "processing"; side: S; auto?: boolean };

export type PaneAction<S extends string = string> =
  /** Open an auto turn: no direction, the language tags drive it. */
  | { kind: "start-auto" }
  /** Open one turn in this side's direction (today's tapped turn). */
  | { kind: "start-forced"; side: S }
  /** End the open turn — the lit button was tapped. */
  | { kind: "end"; side: S }
  | { kind: "none" };

/**
 * `autoActive` is the shell's own: the gate let auto in, the checkbox is on,
 * and the engine is live. Off, nothing changes — a tap is a forced turn, and
 * a long-press is just a slow tap.
 */
export function paneAction<S extends string>(input: {
  autoActive: boolean;
  turn: PaneTurn<S>;
  side: S;
  gesture: "tap" | "long-press";
}): PaneAction<S> {
  const { autoActive, turn, side, gesture } = input;
  if (turn.kind === "idle") {
    if (autoActive && gesture === "tap") return { kind: "start-auto" };
    return { kind: "start-forced", side };
  }
  if (turn.kind !== "recording") return { kind: "none" };
  // Either lit button ends an auto turn — the side it is on is only whoever
  // spoke last. A forced or auto-off turn ends from its own side only.
  if (turn.auto || turn.side === side) return { kind: "end", side: turn.side };
  return { kind: "none" };
}

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

export interface LongPressTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

/**
 * Long-press on one pane button, from pointer events. `onLongPress` fires
 * while the finger is still down, at `ms`. The click the browser sends after
 * the finger lifts is then the long-press's, not a tap, so `takeClick()`
 * answers false and the shell drops it; it also answers false after the
 * finger moved more than `slopPx` (a drag is nothing at all). Every other
 * click — a plain tap, a keyboard Enter — goes through.
 */
export function createLongPress(opts: {
  onLongPress: () => void;
  ms?: number;
  slopPx?: number;
  timers?: LongPressTimers;
}) {
  const ms = opts.ms ?? LONG_PRESS_MS;
  const slop = opts.slopPx ?? LONG_PRESS_SLOP_PX;
  const timers: LongPressTimers = opts.timers ?? {
    set: (fn, t) => setTimeout(fn, t),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
  };
  let handle: unknown = null;
  let origin: { x: number; y: number } | null = null;
  // The next click belongs to a gesture that already decided (fired or moved).
  let swallow = false;

  const stopTimer = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };

  return {
    down(x: number, y: number): void {
      stopTimer();
      origin = { x, y };
      swallow = false;
      handle = timers.set(() => {
        handle = null;
        origin = null;
        swallow = true;
        opts.onLongPress();
      }, ms);
    },
    move(x: number, y: number): void {
      if (!origin) return;
      if (Math.hypot(x - origin.x, y - origin.y) > slop) {
        stopTimer();
        origin = null;
        swallow = true;
      }
    },
    up(): void {
      stopTimer();
      origin = null;
    },
    /** pointercancel: the OS took the gesture (scroll, call, etc.). */
    cancel(): void {
      stopTimer();
      origin = null;
      swallow = true;
    },
    /** True if this click is a tap; false if a long-press or drag owns it. */
    takeClick(): boolean {
      const ok = !swallow;
      swallow = false;
      return ok;
    }
  };
}
