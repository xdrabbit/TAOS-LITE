// Robust screen wake lock holder, shared by every screen that must not sleep
// (/translate, /tabletop, /live, /call).
//
// Why this module exists (Tom, 8/2: "the phone is allowed to go into screen
// sleep mode" mid-recording): every shell re-acquired the lock only on
// visibilitychange. But iOS releases a wake lock WITHOUT any visibility change
// — Low Power Mode engaging, thermal/battery pressure, a notification-shade
// peek — and announces it only through the sentinel's "release" event, which
// nothing listened to. Worse, every request failure was swallowed by an empty
// catch, so one transient denial at page load meant no lock for the whole
// session, silently.
//
// This holder:
//  - subscribes to the sentinel's "release" event and re-acquires when the
//    page is visible and the hold is still wanted;
//  - re-acquires on visibilitychange (the old behavior, kept);
//  - is safe to call ensure() from user gestures (recording start, call join)
//    so a previously denied lock gets another chance at the moment it matters;
//  - releases promptly when shouldHold() turns false or stop() is called.
//
// A denied request (e.g. Low Power Mode) stays denied until the next ensure()
// — there is deliberately no retry timer; the OS said no, and the next
// meaningful moment (gesture, visibility, release event) asks again.

interface SentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
}

export interface WakeLockLike {
  request(type: "screen"): Promise<SentinelLike>;
}

export interface WakeLockHold {
  /** Acquire (or re-acquire) if wanted and not already held; release if not wanted. */
  ensure(): void;
  /** Release and detach everything. The hold is dead afterwards. */
  stop(): void;
}

export interface WakeLockHoldOptions {
  /** Injection point for tests. Defaults to navigator.wakeLock. */
  getLock?: () => WakeLockLike | undefined;
  /** Injection point for tests. Defaults to document.visibilityState. */
  getVisibility?: () => "visible" | "hidden";
  /** Delay before re-acquiring after an OS-initiated release. */
  reacquireDelayMs?: number;
}

export function createWakeLockHold(
  shouldHold: () => boolean,
  opts?: WakeLockHoldOptions
): WakeLockHold {
  const getLock =
    opts?.getLock ??
    (() =>
      typeof navigator !== "undefined"
        ? (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock
        : undefined);
  const getVisibility =
    opts?.getVisibility ??
    (() => (typeof document !== "undefined" ? document.visibilityState : "visible")) as () =>
      | "visible"
      | "hidden";
  const reacquireDelayMs = opts?.reacquireDelayMs ?? 250;

  let sentinel: SentinelLike | null = null;
  let requesting = false;
  let stopped = false;

  function releaseCurrent(): void {
    const s = sentinel;
    sentinel = null;
    if (s) void s.release().catch(() => {});
  }

  function ensure(): void {
    if (stopped) return;
    if (!shouldHold()) {
      releaseCurrent();
      return;
    }
    if (sentinel && sentinel.released !== true) return; // already held
    if (requesting) return; // one request in flight is enough
    const lock = getLock();
    if (!lock) return; // unsupported browser — nothing to hold
    requesting = true;
    lock
      .request("screen")
      .then((s) => {
        requesting = false;
        if (stopped || !shouldHold()) {
          void s.release().catch(() => {});
          return;
        }
        sentinel = s;
        // The OS can release WITHOUT a visibilitychange (Low Power Mode,
        // pressure). This listener is the fix the old per-shell code lacked.
        s.addEventListener?.("release", () => {
          if (sentinel === s) sentinel = null;
          if (stopped) return;
          setTimeout(() => {
            if (!stopped && getVisibility() === "visible") ensure();
          }, reacquireDelayMs);
        });
      })
      .catch(() => {
        // Denied (Low Power Mode, battery). The next ensure() retries.
        requesting = false;
      });
  }

  const onVisibility = () => {
    if (getVisibility() === "visible") ensure();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  return {
    ensure,
    stop() {
      stopped = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      releaseCurrent();
    }
  };
}
