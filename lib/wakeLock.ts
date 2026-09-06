// Screen wake lock, scoped to the moments that need it.
//
// History, because this file has now overshot in both directions:
//
//  - 8/2 (Tom): "the phone is allowed to go into screen sleep mode" mid-
//    recording. The per-shell inline locks only re-acquired on
//    visibilitychange, and iOS drops a lock WITHOUT one (Low Power Mode,
//    thermal/battery pressure) — announcing it only through the sentinel's
//    "release" event, which nothing listened to. That fix is still here.
//  - 9/6 (Tom): any device with TAOS open never sleeps. His iPhone went from
//    ~2 days of battery to ~half a day just from leaving the tab open. The
//    8/2 fix was acquired at MOUNT and wanted for the life of the page, so
//    the lock outlived the translation by hours.
//
// The rule now: a lock belongs to a TURN, not to a page.
//
//  - hold(reason) / release(reason), keyed by reason. The lock is held while
//    at least one reason is active — a call and a mic can overlap without
//    fighting over one sentinel.
//  - Nothing acquires at mount. The acquiring moments are: the push-to-talk
//    mic opening, a /call connecting, a /live session starting, the /fast mic
//    going live, a tutor speech attempt recording.
//  - GRACE: the last release() does not drop the lock for 60s, so the pause
//    between two turns of a conversation does not blink the screen off. A new
//    hold inside the grace cancels the pending release.
//  - IDLE CAP: a reason that has not been refreshed in 60s is dropped, and if
//    that empties the set the lock goes immediately — no grace. Ongoing
//    sessions prove they are alive via keep(), which re-holds every 20s. A
//    session whose refresher dies (crashed shell, torn-down page) cannot leak
//    the lock past a minute. No lock survives an idle screen.
//  - Hidden means released, explicitly (the browser does it anyway); coming
//    back visible re-acquires only if a reason is still active.
//
// request() never throws out of here: iOS Safari rejects in Low Power Mode
// and can reject outside a gesture. A denial stays denied until the next
// hold() — deliberately no retry timer; the OS said no, and the next
// meaningful moment (a tap, a visibility return, a release event) asks again.

/** The last release waits this long before the lock actually drops. */
export const WAKE_GRACE_MS = 60_000;
/** A hold not refreshed within this window is dropped regardless. */
export const WAKE_IDLE_CAP_MS = 60_000;
/** keep() re-holds on this cadence — comfortably inside the idle cap. */
export const WAKE_REFRESH_MS = 20_000;

const SWEEP_MS = 5_000;
const REACQUIRE_DELAY_MS = 250;

interface SentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
}

export interface WakeLockLike {
  request(type: "screen"): Promise<SentinelLike>;
}

export type WakeLogSink = (line: string) => void;

export interface WakeLockManagerOptions {
  /** Injection point for tests. Defaults to navigator.wakeLock. */
  getLock?: () => WakeLockLike | undefined;
  /** Injection point for tests. Defaults to document.visibilityState. */
  getVisibility?: () => "visible" | "hidden";
  graceMs?: number;
  idleCapMs?: number;
  sweepMs?: number;
  reacquireDelayMs?: number;
  /** Attach the visibilitychange listener. Off for tests. */
  watchVisibility?: boolean;
}

export interface WakeLockManager {
  /** Acquire (or refresh) the lock for this reason. */
  hold(reason: string): void;
  /** Drop this reason. The lock survives the grace window if nothing else wants it. */
  release(reason: string): void;
  /** hold() plus a refresh heartbeat. The returned function releases. */
  keep(reason: string, refreshMs?: number): () => void;
  /** What the document listener calls; tests call it directly. */
  notifyVisibility(): void;
  /** Subscribe to the hold/release trail. Returns an unsubscribe. */
  onLog(sink: WakeLogSink): () => void;
  /** Diagnostics: the reasons currently wanting the screen awake. */
  activeReasons(): string[];
  /** Diagnostics: whether an OS lock is actually held right now. */
  isHeld(): boolean;
  destroy(): void;
}

export function createWakeLockManager(opts: WakeLockManagerOptions = {}): WakeLockManager {
  const getLock =
    opts.getLock ??
    (() =>
      typeof navigator !== "undefined"
        ? (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock
        : undefined);
  const getVisibility: () => "visible" | "hidden" =
    opts.getVisibility ??
    (() =>
      typeof document !== "undefined"
        ? (document.visibilityState as "visible" | "hidden")
        : "visible");
  const graceMs = opts.graceMs ?? WAKE_GRACE_MS;
  const idleCapMs = opts.idleCapMs ?? WAKE_IDLE_CAP_MS;
  const sweepMs = opts.sweepMs ?? SWEEP_MS;
  const reacquireDelayMs = opts.reacquireDelayMs ?? REACQUIRE_DELAY_MS;

  /** reason → the moment it was last held or refreshed. */
  const reasons = new Map<string, number>();
  const sinks = new Set<WakeLogSink>();
  let sentinel: SentinelLike | null = null;
  let requesting = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  function log(line: string): void {
    for (const sink of sinks) {
      try {
        sink(`wake: ${line}`);
      } catch {
        // A broken trail must never take the lock down with it.
      }
    }
  }

  /** True while the lock should exist — an active reason, or an unexpired grace. */
  function wanted(): boolean {
    return reasons.size > 0 || graceTimer !== null;
  }

  function dropLock(): void {
    const s = sentinel;
    sentinel = null;
    if (!s) return;
    log("screen lock off");
    void s.release().catch(() => {});
  }

  function ensure(): void {
    if (destroyed) return;
    if (!wanted() || getVisibility() !== "visible") {
      dropLock();
      return;
    }
    if (sentinel && sentinel.released !== true) return; // already held
    if (requesting) return; // one request in flight is enough
    const lock = getLock();
    if (!lock) return; // unsupported browser — nothing to hold
    requesting = true;
    try {
      lock
        .request("screen")
        .then((s) => {
          requesting = false;
          if (destroyed || !wanted() || getVisibility() !== "visible") {
            void s.release().catch(() => {});
            return;
          }
          sentinel = s;
          log("screen lock on");
          // The OS can release WITHOUT a visibilitychange (Low Power Mode,
          // pressure). This listener is the 8/2 fix; it stays.
          s.addEventListener?.("release", () => {
            if (sentinel === s) sentinel = null;
            if (destroyed) return;
            setTimeout(() => {
              if (!destroyed && getVisibility() === "visible" && wanted()) ensure();
            }, reacquireDelayMs);
          });
        })
        .catch(() => {
          // Denied (Low Power Mode, battery). The next hold() retries.
          requesting = false;
          log("screen lock denied");
        });
    } catch {
      requesting = false;
      log("screen lock denied");
    }
  }

  function cancelGrace(): void {
    if (graceTimer === null) return;
    clearTimeout(graceTimer);
    graceTimer = null;
  }

  function scheduleGrace(): void {
    cancelGrace();
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (reasons.size > 0) return; // something took over during the grace
      dropLock();
      stopSweep();
    }, graceMs);
  }

  function sweep(): void {
    if (destroyed) return;
    // Hidden already means released, and background timers are throttled —
    // sweeping there would only invent staleness the user never caused.
    if (getVisibility() !== "visible") return;
    const cutoff = Date.now() - idleCapMs;
    let dropped = false;
    for (const [reason, at] of reasons) {
      if (at > cutoff) continue;
      reasons.delete(reason);
      dropped = true;
      log(`idle cap dropped ${reason}`);
    }
    if (!dropped) return;
    if (reasons.size > 0) return;
    // Already idle for a full minute — the grace has nothing left to protect.
    cancelGrace();
    dropLock();
    stopSweep();
  }

  function startSweep(): void {
    if (sweepTimer !== null || destroyed) return;
    sweepTimer = setInterval(sweep, sweepMs);
  }

  function stopSweep(): void {
    if (sweepTimer === null) return;
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  function hold(reason: string): void {
    if (destroyed) return;
    const fresh = !reasons.has(reason);
    reasons.set(reason, Date.now());
    cancelGrace(); // a new hold inside the grace cancels the pending release
    if (fresh) log(`hold ${reason}`);
    startSweep();
    ensure();
  }

  function release(reason: string): void {
    if (destroyed) return;
    if (!reasons.delete(reason)) return;
    log(`release ${reason}`);
    if (reasons.size === 0) scheduleGrace();
  }

  const onVisibility = () => {
    if (destroyed) return;
    if (getVisibility() !== "visible") {
      log("hidden");
      dropLock();
      return;
    }
    // Coming back IS activity: time spent hidden must not count against the
    // idle cap, or a two-minute detour would kill a live call on return.
    const at = Date.now();
    for (const reason of reasons.keys()) reasons.set(reason, at);
    ensure();
  };

  const watching = (opts.watchVisibility ?? true) && typeof document !== "undefined";
  if (watching) document.addEventListener("visibilitychange", onVisibility);

  return {
    hold,
    release,
    keep(reason: string, refreshMs = WAKE_REFRESH_MS) {
      hold(reason);
      const id = setInterval(() => hold(reason), refreshMs);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(id);
        release(reason);
      };
    },
    notifyVisibility: onVisibility,
    onLog(sink: WakeLogSink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    activeReasons: () => [...reasons.keys()],
    isHeld: () => sentinel !== null && sentinel.released !== true,
    destroy() {
      destroyed = true;
      cancelGrace();
      stopSweep();
      reasons.clear();
      if (watching) document.removeEventListener("visibilitychange", onVisibility);
      dropLock();
      sinks.clear();
    }
  };
}

// One manager per page. Created lazily so nothing touches document during SSR.
let shared: WakeLockManager | null = null;
function manager(): WakeLockManager {
  if (!shared) shared = createWakeLockManager();
  return shared;
}

/** Acquire (or refresh) the screen lock for this reason. */
export function holdWake(reason: string): void {
  manager().hold(reason);
}

/** Drop this reason. The lock outlives it by the grace window. */
export function releaseWake(reason: string): void {
  manager().release(reason);
}

/**
 * hold() plus the heartbeat that keeps it past the idle cap. Returns the
 * release — shaped for `useEffect(() => { if (!active) return; return keepWake(r); })`.
 */
export function keepWake(reason: string, refreshMs?: number): () => void {
  return manager().keep(reason, refreshMs);
}

/** Subscribe an on-screen trail to the hold/release lines. Returns unsubscribe. */
export function onWakeLog(sink: WakeLogSink): () => void {
  return manager().onLog(sink);
}
