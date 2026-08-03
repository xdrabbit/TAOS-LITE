// Pins the wake-lock holder behavior that fixes the 8/2 field report ("the
// phone is allowed to go into screen sleep mode" mid-recording). The old
// per-shell code re-acquired ONLY on visibilitychange; iOS releases the lock
// without one (Low Power Mode, pressure) and announces it via the sentinel's
// "release" event — the case these tests exist to keep covered.
import { describe, expect, it } from "vitest";
import { createWakeLockHold, type WakeLockLike } from "@/lib/wakeLock";

interface FakeSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  /** Test hook: simulate the OS releasing the lock out from under us. */
  osRelease(): void;
}

function makeFake(behavior: { failFirst?: number } = {}) {
  const sentinels: FakeSentinel[] = [];
  let requests = 0;
  let failuresLeft = behavior.failFirst ?? 0;
  const lock: WakeLockLike = {
    request: () => {
      requests++;
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

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("createWakeLockHold", () => {
  it("acquires when wanted, and ensure() while held is a no-op", async () => {
    const fake = makeFake();
    const hold = createWakeLockHold(() => true, {
      getLock: () => fake.lock,
      getVisibility: () => "visible",
      reacquireDelayMs: 0
    });
    hold.ensure();
    await tick();
    hold.ensure();
    hold.ensure();
    await tick();
    expect(fake.requestCount()).toBe(1); // held → no extra requests
    hold.stop();
  });

  it("re-acquires when the OS releases the lock WITHOUT a visibility change", async () => {
    const fake = makeFake();
    const hold = createWakeLockHold(() => true, {
      getLock: () => fake.lock,
      getVisibility: () => "visible",
      reacquireDelayMs: 0
    });
    hold.ensure();
    await tick();
    expect(fake.sentinels).toHaveLength(1);
    fake.sentinels[0].osRelease(); // Low Power Mode kicked in
    await tick();
    expect(fake.requestCount()).toBe(2); // got it back on its own
    hold.stop();
  });

  it("does NOT re-acquire after stop(), and releases what it held", async () => {
    const fake = makeFake();
    const hold = createWakeLockHold(() => true, {
      getLock: () => fake.lock,
      getVisibility: () => "visible",
      reacquireDelayMs: 0
    });
    hold.ensure();
    await tick();
    hold.stop();
    expect(fake.sentinels[0].released).toBe(true);
    fake.sentinels[0].osRelease();
    await tick();
    expect(fake.requestCount()).toBe(1);
  });

  it("releases when shouldHold() turns false and re-acquires when it turns true", async () => {
    const fake = makeFake();
    let wanted = true;
    const hold = createWakeLockHold(() => wanted, {
      getLock: () => fake.lock,
      getVisibility: () => "visible",
      reacquireDelayMs: 0
    });
    hold.ensure();
    await tick();
    wanted = false;
    hold.ensure();
    expect(fake.sentinels[0].released).toBe(true);
    wanted = true;
    hold.ensure();
    await tick();
    expect(fake.requestCount()).toBe(2);
    hold.stop();
  });

  it("a denied request is not fatal — the next ensure() (a gesture) retries", async () => {
    const fake = makeFake({ failFirst: 1 });
    const hold = createWakeLockHold(() => true, {
      getLock: () => fake.lock,
      getVisibility: () => "visible",
      reacquireDelayMs: 0
    });
    hold.ensure(); // denied (Low Power Mode)
    await tick();
    expect(fake.sentinels).toHaveLength(0);
    hold.ensure(); // user taps Speak — try again
    await tick();
    expect(fake.sentinels).toHaveLength(1);
    expect(fake.sentinels[0].released).toBe(false);
    hold.stop();
  });

  it("does not re-acquire while hidden after an OS release (waits for visibility)", async () => {
    const fake = makeFake();
    let vis: "visible" | "hidden" = "visible";
    const hold = createWakeLockHold(() => true, {
      getLock: () => fake.lock,
      getVisibility: () => vis,
      reacquireDelayMs: 0
    });
    hold.ensure();
    await tick();
    vis = "hidden";
    fake.sentinels[0].osRelease();
    await tick();
    expect(fake.requestCount()).toBe(1); // stayed quiet while hidden
    vis = "visible";
    hold.ensure(); // what the visibilitychange listener does on return
    await tick();
    expect(fake.requestCount()).toBe(2);
    hold.stop();
  });
});
