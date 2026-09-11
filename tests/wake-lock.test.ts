// Pins the wake lock's SCOPE, which has now been wrong in both directions.
//
// 8/2 (Tom): the phone slept mid-recording — the per-shell code re-acquired
// only on visibilitychange, and iOS drops a lock without one. That fix is
// still pinned here (the sentinel "release" case).
//
// 9/6 (Tom): any device with TAOS open never slept — his iPhone went from two
// days of battery to half a day. The 8/2 fix acquired at MOUNT and wanted the
// lock for the life of the page. These tests pin the replacement rule: a lock
// belongs to a turn, survives a 60s grace between turns, and cannot outlive a
// 60s idle cap.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWakeLockManager,
  WAKE_GRACE_MS,
  WAKE_IDLE_CAP_MS,
  WAKE_REFRESH_MS,
  type WakeLockLike,
  type WakeLockManager
} from "@/lib/wakeLock";

interface FakeSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  /** Test hook: simulate the OS releasing the lock out from under us. */
  osRelease(): void;
}

function makeFake(behavior: { failFirst?: number; throwFirst?: number } = {}) {
  const sentinels: FakeSentinel[] = [];
  let requests = 0;
  let failuresLeft = behavior.failFirst ?? 0;
  let throwsLeft = behavior.throwFirst ?? 0;
  const lock: WakeLockLike = {
    request: () => {
      requests++;
      if (throwsLeft > 0) {
        throwsLeft--;
        throw new Error("SecurityError (synchronous)");
      }
      if (failuresLeft > 0) {
        failuresLeft--;
        return Promise.reject(new Error("NotAllowedError (low power mode)"));
      }
      const listeners: Array<() => void> = [];
      const s: FakeSentinel = {
        released: false,
        release: () => {
          s.released = true;
          return Promise.resolve();
        },
        addEventListener: (_t, l) => listeners.push(l),
        osRelease: () => {
          s.released = true;
          listeners.forEach((l) => l());
        }
      };
      sentinels.push(s);
      return Promise.resolve(s);
    }
  };
  return { lock, sentinels, requestCount: () => requests };
}

/** Let the request promise settle without moving the clock meaningfully. */
const settle = () => vi.advanceTimersByTimeAsync(1);

let made: WakeLockManager[] = [];
function manager(fake: ReturnType<typeof makeFake>, vis: () => "visible" | "hidden" = () => "visible") {
  const m = createWakeLockManager({
    getLock: () => fake.lock,
    getVisibility: vis,
    watchVisibility: false,
    reacquireDelayMs: 0
  });
  made.push(m);
  return m;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  made.forEach((m) => m.destroy());
  made = [];
  vi.useRealTimers();
});

describe("wake lock scope", () => {
  it("holds nothing until something asks — mount is not a reason", async () => {
    const fake = makeFake();
    const m = manager(fake);
    await vi.advanceTimersByTimeAsync(WAKE_IDLE_CAP_MS * 2);
    expect(fake.requestCount()).toBe(0);
    expect(m.isHeld()).toBe(false);
    expect(m.activeReasons()).toEqual([]);
  });

  it("acquires when the mic opens, and a repeat hold is not a second request", async () => {
    const fake = makeFake();
    const m = manager(fake);
    m.hold("home-mic");
    await settle();
    expect(m.isHeld()).toBe(true);
    m.hold("home-mic");
    m.hold("home-mic");
    await settle();
    expect(fake.requestCount()).toBe(1);
  });

  it("keeps the lock through the 60s grace after stop, then drops it", async () => {
    const fake = makeFake();
    const m = manager(fake);
    m.hold("home-mic");
    await settle();
    m.release("home-mic");
    expect(m.activeReasons()).toEqual([]);

    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS - 1000);
    expect(m.isHeld()).toBe(true); // the pause between two turns

    await vi.advanceTimersByTimeAsync(2000);
    expect(m.isHeld()).toBe(false);
    expect(fake.sentinels[0].released).toBe(true);
  });

  it("a new hold inside the grace cancels the pending release", async () => {
    const fake = makeFake();
    const m = manager(fake);
    m.hold("home-mic");
    await settle();
    m.release("home-mic");
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS / 2);
    m.hold("home-mic"); // the next turn starts
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(m.isHeld()).toBe(true);
    expect(fake.requestCount()).toBe(1); // never dropped, so never re-requested
  });

  it("idle cap: a hold nobody refreshes is dropped at 60s, with no grace", async () => {
    const fake = makeFake();
    const m = manager(fake);
    m.hold("stuck-session"); // a shell that crashed before releasing
    await settle();
    await vi.advanceTimersByTimeAsync(WAKE_IDLE_CAP_MS - 10_000);
    expect(m.isHeld()).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(m.activeReasons()).toEqual([]);
    expect(m.isHeld()).toBe(false); // released regardless — no idle screen holds
  });

  it("keep() outlives the idle cap while live, and releases on its stop", async () => {
    const fake = makeFake();
    const m = manager(fake);
    const stop = m.keep("call", WAKE_REFRESH_MS);
    await settle();
    // A three-minute call: the heartbeat re-holds inside every idle window.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(m.isHeld()).toBe(true);
    expect(m.activeReasons()).toEqual(["call"]);

    stop();
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS + 1000);
    expect(m.isHeld()).toBe(false);
  });

  it("two reasons overlap: the lock survives until the last one lets go", async () => {
    const fake = makeFake();
    const m = manager(fake);
    const stopCall = m.keep("call", WAKE_REFRESH_MS);
    m.hold("home-mic");
    await settle();
    m.release("home-mic");
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS + 1000);
    expect(m.isHeld()).toBe(true); // "call" never let go
    expect(m.activeReasons()).toEqual(["call"]);
    stopCall();
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS + 1000);
    expect(m.isHeld()).toBe(false);
  });

  it("releases when hidden and re-acquires on visible only if a reason is active", async () => {
    const fake = makeFake();
    let vis: "visible" | "hidden" = "visible";
    const m = manager(fake, () => vis);
    m.hold("live-session");
    await settle();
    expect(m.isHeld()).toBe(true);

    vis = "hidden";
    m.notifyVisibility();
    expect(m.isHeld()).toBe(false);

    vis = "visible";
    m.notifyVisibility();
    await settle();
    expect(m.isHeld()).toBe(true); // still wanted → back on
    expect(fake.requestCount()).toBe(2);

    m.release("live-session");
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS + 1000);
    vis = "hidden";
    m.notifyVisibility();
    vis = "visible";
    m.notifyVisibility();
    await settle();
    expect(m.isHeld()).toBe(false); // nothing active → nothing re-acquired
    expect(fake.requestCount()).toBe(2);
  });

  it("time spent hidden does not count against the idle cap", async () => {
    const fake = makeFake();
    let vis: "visible" | "hidden" = "visible";
    const m = manager(fake, () => vis);
    m.hold("call");
    await settle();
    vis = "hidden";
    m.notifyVisibility();
    await vi.advanceTimersByTimeAsync(WAKE_IDLE_CAP_MS * 2); // a long detour
    vis = "visible";
    m.notifyVisibility();
    await settle();
    expect(m.activeReasons()).toEqual(["call"]);
    expect(m.isHeld()).toBe(true);
  });

  it("re-acquires when the OS releases the lock WITHOUT a visibility change", async () => {
    const fake = makeFake();
    const m = manager(fake);
    m.hold("home-mic");
    await settle();
    fake.sentinels[0].osRelease(); // Low Power Mode kicked in
    await settle();
    expect(fake.requestCount()).toBe(2); // got it back on its own
    expect(m.isHeld()).toBe(true);
  });

  it("does not re-acquire after an OS release once the reason is gone", async () => {
    const fake = makeFake();
    const m = manager(fake);
    m.hold("home-mic");
    await settle();
    m.release("home-mic");
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS + 1000);
    fake.sentinels[0].osRelease();
    await settle();
    expect(fake.requestCount()).toBe(1);
    expect(m.isHeld()).toBe(false);
  });

  it("a rejected request does not throw — the next hold retries", async () => {
    const fake = makeFake({ failFirst: 1 });
    const m = manager(fake);
    expect(() => m.hold("home-mic")).not.toThrow(); // iOS Low Power Mode
    await settle();
    expect(m.isHeld()).toBe(false);
    m.hold("home-mic"); // the user taps Speak again
    await settle();
    expect(m.isHeld()).toBe(true);
  });

  it("a synchronously throwing request() does not throw either", async () => {
    const fake = makeFake({ throwFirst: 1 });
    const m = manager(fake);
    expect(() => m.hold("home-mic")).not.toThrow();
    await settle();
    expect(m.isHeld()).toBe(false);
  });

  it("an absent navigator.wakeLock is a no-op, not a crash", async () => {
    const m = createWakeLockManager({
      getLock: () => undefined,
      getVisibility: () => "visible",
      watchVisibility: false
    });
    made.push(m);
    expect(() => m.hold("home-mic")).not.toThrow();
    await settle();
    expect(m.isHeld()).toBe(false);
  });

  it("writes the hold and the release to the trail Liz can screenshot", async () => {
    const fake = makeFake();
    const m = manager(fake);
    const lines: string[] = [];
    const off = m.onLog((l) => lines.push(l));
    m.hold("home-mic");
    await settle();
    m.release("home-mic");
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS + 1000);
    off();
    expect(lines).toContain("wake: hold home-mic");
    expect(lines).toContain("wake: release home-mic");
    expect(lines).toContain("wake: screen lock on");
    expect(lines).toContain("wake: screen lock off");
  });
});
