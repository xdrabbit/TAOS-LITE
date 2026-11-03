// @vitest-environment jsdom
// /taokie, mounted: the button after the first two-phone test (2026-11-01).
//
// What the Galaxy S23 showed: a tap whose finger left before the microphone
// had opened (getUserMedia takes 200-800 ms on a phone, and the mic is
// re-opened every turn) was ignored by PR #114's release handlers, so the
// recording started after the finger was gone and ran until the next tap.
// And lostpointercapture, firing after every pointerup, stopped each turn a
// second time and stamped it cancelled=1 — all 22 turns that night.
//
// This mounts the real shell with a fake, slow microphone and drives the
// real button with pointer events. The rules are pinned in
// tests/walkie.test.ts (lib/walkie/toggle.ts); this proves the shell obeys
// them: tap starts, tap sends, the cap sends, pointercancel sends what was
// heard, and whatever else arrives while the mic is opening is nothing.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";

const rig = vi.hoisted(() => ({
  micDelayMs: 300,
  recorders: [] as Array<{ state: string; stops: number }>,
  turns: [] as FormData[],
  acks: [] as Array<Record<string, unknown>>,
  chirps: [] as string[],
  partnerEvents: null as null | {
    onPartner?: (s: unknown) => void;
    onGot?: (id: string) => void;
    onReady?: (m: { id: string; releasedAt: number | null }) => void;
    onStatus?: (s: string) => void;
  },
  channel: {
    setHolding: vi.fn(),
    setLanguage: vi.fn(),
    sendReady: vi.fn(),
    sendGot: vi.fn(),
    sendPlayed: vi.fn(),
    resync: vi.fn(() => true),
    isJoined: vi.fn(() => true),
    leave: vi.fn(async () => {})
  }
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/taokie",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: "t", user: { id: "u-tom", email: "xdrabbit@gmail.com" } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
    },
    getChannels: () => [],
    removeChannel: async () => {}
  }
}));
vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));
vi.mock("@/lib/walkie/chirps", () => ({
  createWalkieChirps: () => ({
    unlock: async () => true,
    keyDown: () => rig.chirps.push("keyDown"),
    roger: () => rig.chirps.push("roger"),
    busy: () => rig.chirps.push("busy"),
    close: () => {}
  })
}));
vi.mock("@/lib/walkie/channel", () => ({
  joinWalkieChannel: async (_c: unknown, events: NonNullable<typeof rig.partnerEvents>) => {
    rig.partnerEvents = events;
    events.onPartner?.({ lang: "es", name: "Liz", holding: false });
    return rig.channel;
  }
}));
vi.mock("@/lib/wakeLock", () => ({ keepWake: () => () => {} }));

class FakeRecorder {
  state = "inactive";
  stops = 0;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: MediaStream) {
    rig.recorders.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.stops += 1;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(4000)], { type: "audio/webm" }) });
    setTimeout(() => this.onstop?.(), 0);
  }
  static isTypeSupported() {
    return true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MSG = {
  id: "11111111-2222-4333-8444-555555555555",
  sender_id: "u-tom",
  source_lang: "en",
  target_lang: "es",
  original_text: "x",
  translation_text: "y",
  speech_url: null,
  created_at: new Date().toISOString(),
  delivered_at: null,
  played_at: null
};

beforeEach(() => {
  rig.recorders.length = 0;
  rig.turns.length = 0;
  rig.acks.length = 0;
  rig.chirps.length = 0;
  rig.micDelayMs = 300;
  rig.partnerEvents = null;
  for (const f of Object.values(rig.channel)) (f as { mockClear?: () => void }).mockClear?.();
  rig.channel.isJoined.mockReturnValue(true);
  window.localStorage.clear();
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(["en", "es"]));
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal(
    "Audio",
    class {
      playsInline = false;
      src = "";
      play = async () => {};
      pause = () => {};
    }
  );
  Object.defineProperty(window, "matchMedia", { writable: true, value: () => ({ matches: false }) });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        await sleep(rig.micDelayMs);
        return { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
      }
    }
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/walkie/turn")) {
        rig.turns.push(init?.body as FormData);
        return new Response(JSON.stringify({ message: { ...MSG, id: `${MSG.id.slice(0, -2)}${String(rig.turns.length).padStart(2, "0")}` } }), {
          status: 200
        });
      }
      if (u.includes("/api/walkie/ack")) {
        rig.acks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      }
      if (u.includes("/api/walkie/messages")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    })
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(maxTurnMs = 30_000): Promise<{ c: HTMLElement; btn: HTMLElement }> {
  const { WalkieShell } = await import("@/components/walkie/WalkieShell");
  const Shell = WalkieShell as ComponentType<{ maxTurnMs?: number }>;
  const { container } = render(createElement(Shell, { maxTurnMs }));
  await act(async () => {});
  fireEvent.change(container.querySelector("#walkie-room") as HTMLInputElement, { target: { value: "ABCDE" } });
  await act(async () => {});
  fireEvent.click(container.querySelector("[data-walkie-on-air]") as HTMLElement);
  await act(async () => {
    await sleep(20);
  });
  const btn = container.querySelector("[data-walkie-hold]") as HTMLElement;
  expect(btn).not.toBeNull();
  return { c: container, btn };
}

const tap = (btn: HTMLElement, pointerId = 1) => fireEvent.pointerDown(btn, { pointerId, button: 0 });
const lift = (btn: HTMLElement, pointerId = 1) => {
  fireEvent.pointerUp(btn, { pointerId, button: 0 });
  fireEvent.lostPointerCapture(btn, { pointerId });
  fireEvent.click(btn);
};

describe("/taokie button, mounted: tap to talk, tap to send", () => {
  it("a quick tap starts the turn even though the mic opens after the finger left; the next tap sends it", async () => {
    const { btn } = await mount();
    await act(async () => {
      tap(btn);
      await sleep(40);
      lift(btn);
      await sleep(600); // mic opened at ~300 ms, finger long gone
    });
    expect(btn.getAttribute("data-walkie-rec")).toBe("recording");
    expect(btn.textContent).toMatch(/TAP TO SEND/i);
    expect(rig.recorders).toHaveLength(1);
    expect(rig.recorders[0].state).toBe("recording");
    expect(rig.chirps).toEqual(["keyDown"]);
    expect(rig.channel.setHolding).toHaveBeenLastCalledWith(true);
    expect(rig.turns).toHaveLength(0);

    await act(async () => {
      await sleep(700); // past MIN_TURN_DURATION_MS
      tap(btn, 2);
      lift(btn, 2);
      await sleep(50);
    });
    expect(rig.recorders[0].state).toBe("inactive");
    expect(rig.recorders[0].stops).toBe(1);
    expect(rig.turns).toHaveLength(1);
    expect(rig.turns[0].get("cancelled")).toBe("0"); // a normal send is not a cancel
    expect(rig.channel.setHolding).toHaveBeenLastCalledWith(false);
    expect(rig.channel.sendReady).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute("data-walkie-rec")).toBe("idle");
  });

  it("a hold-and-release (the old habit) does the same: the release is not an event", async () => {
    const { btn } = await mount();
    await act(async () => {
      tap(btn);
      await sleep(1200);
      lift(btn);
      await sleep(50);
    });
    expect(rig.recorders[0].state).toBe("recording");
    expect(rig.turns).toHaveLength(0);
  });

  it("taps while the mic is still opening change nothing", async () => {
    const { btn } = await mount();
    await act(async () => {
      tap(btn);
      await sleep(40);
      lift(btn);
      tap(btn, 2); // second tap, mic not open yet
      lift(btn, 2);
      await sleep(600);
    });
    expect(rig.recorders).toHaveLength(1);
    expect(rig.recorders[0].state).toBe("recording");
    expect(rig.chirps).toEqual(["keyDown"]); // one key-down, not two
  });

  it("pointercancel while recording sends what was heard, marked cancelled, once", async () => {
    const { btn } = await mount();
    await act(async () => {
      tap(btn);
      await sleep(1000);
      fireEvent.pointerCancel(btn, { pointerId: 1 });
      fireEvent.lostPointerCapture(btn, { pointerId: 1 });
      fireEvent.pointerCancel(btn, { pointerId: 1 });
      await sleep(50);
    });
    expect(rig.recorders[0].stops).toBe(1);
    expect(rig.turns).toHaveLength(1);
    expect(rig.turns[0].get("cancelled")).toBe("1");
  });

  it("pointercancel while the mic is opening is nothing: the turn still runs", async () => {
    const { btn } = await mount();
    await act(async () => {
      tap(btn);
      await sleep(40);
      fireEvent.pointerCancel(btn, { pointerId: 1 });
      await sleep(600);
    });
    expect(rig.recorders[0].state).toBe("recording");
    expect(rig.turns).toHaveLength(0);
  });

  it("the cap sends the turn by itself, not cancelled", async () => {
    const { btn } = await mount(5_000);
    await act(async () => {
      tap(btn);
      await sleep(400);
    });
    expect(rig.recorders[0].state).toBe("recording");
    await act(async () => {
      await sleep(5_200);
    });
    expect(rig.recorders[0].state).toBe("inactive");
    expect(rig.turns).toHaveLength(1);
    expect(rig.turns[0].get("cancelled")).toBe("0");
  }, 15_000);

  it("a tap while the partner holds is refused with the busy chirp and counted", async () => {
    const { btn } = await mount();
    await act(async () => {
      rig.partnerEvents?.onPartner?.({ lang: "es", name: "Liz", holding: true });
    });
    expect(btn.textContent).toMatch(/busy/i);
    await act(async () => {
      tap(btn);
      await sleep(400);
    });
    expect(rig.recorders).toHaveLength(0);
    expect(rig.chirps).toEqual(["busy"]);
    // Released (or expired): the next tap records, and the turn carries the count.
    await act(async () => {
      rig.partnerEvents?.onPartner?.({ lang: "es", name: "Liz", holding: false });
    });
    await act(async () => {
      tap(btn, 2);
      await sleep(1100);
      tap(btn, 3);
      await sleep(50);
    });
    expect(rig.turns).toHaveLength(1);
    expect(rig.turns[0].get("busy_blocked")).toBe("1");
  });

  it("a turn nobody picks up shows 'not delivered' and reports fail_stage=deliver; a late 'got' clears it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { c, btn } = await mount();
    await act(async () => {
      tap(btn);
      await sleep(1000);
      tap(btn, 2);
      await sleep(50);
    });
    expect(rig.turns).toHaveLength(1);
    expect(c.querySelector("[data-walkie-receipt]")?.getAttribute("data-walkie-receipt")).toBe("sent");
    await act(async () => {
      vi.advanceTimersByTime(8_100);
    });
    expect(c.querySelector("[data-walkie-receipt]")?.getAttribute("data-walkie-receipt")).toBe("stalled");
    expect(c.querySelector("[data-walkie-error]")?.textContent).toMatch(/not delivered/i);
    expect(rig.acks.some((a) => a.kind === "failed" && a.stage === "deliver")).toBe(true);
    const sentId = (rig.channel.sendReady.mock.calls[0] as unknown[])[0] as string;
    await act(async () => {
      rig.partnerEvents?.onGot?.(sentId);
    });
    expect(c.querySelector("[data-walkie-receipt]")?.getAttribute("data-walkie-receipt")).toBe("delivered");
    expect(c.querySelector("[data-walkie-error]")).toBeNull();
  });

  it("a lost socket shows on the presence line with Resync; Resync re-reads and catches up", async () => {
    const { c } = await mount();
    await act(async () => {
      rig.partnerEvents?.onStatus?.("lost");
    });
    expect(c.querySelector("[data-walkie-presence]")?.textContent).toMatch(/lost/i);
    const fetchMock = fetch as unknown as { mock: { calls: unknown[][] } };
    const before = fetchMock.mock.calls.length;
    await act(async () => {
      fireEvent.click(c.querySelector("[data-walkie-resync]") as HTMLElement);
      await sleep(20);
    });
    expect(rig.channel.resync).toHaveBeenCalledTimes(1);
    const urls = fetchMock.mock.calls.slice(before).map((args) => String(args[0]));
    expect(urls.some((u) => u.includes("/api/walkie/messages?room=ABCDE"))).toBe(true);
    await act(async () => {
      rig.partnerEvents?.onStatus?.("joined");
    });
    expect(c.querySelector("[data-walkie-presence]")?.textContent).not.toMatch(/lost/i);
  });

  it("a playback the speaker refuses shows the banner, offers 'go on air' again, and reports fail_stage=playback", async () => {
    vi.stubGlobal(
      "Audio",
      class {
        playsInline = false;
        src = "";
        onerror: (() => void) | null = null;
        play = async () => {
          throw new DOMException("NotAllowedError", "NotAllowedError");
        };
        pause = () => {};
      }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/api/walkie/ack")) {
          rig.acks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response("{}", { status: 200 });
        }
        if (u.includes("/api/walkie/messages?id=")) {
          return new Response(JSON.stringify({ message: { ...MSG, sender_id: "u-liz", speech_url: "https://signed.example/say.mp3" } }), { status: 200 });
        }
        if (u.includes("/api/walkie/messages")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
        return new Response("{}", { status: 200 });
      })
    );
    const { c } = await mount();
    await act(async () => {
      rig.partnerEvents?.onReady?.({ id: MSG.id, releasedAt: Date.now() });
      await sleep(50);
    });
    expect(c.querySelector('[data-walkie-msg="partner"]')).not.toBeNull();
    expect(c.querySelector("[data-walkie-error]")?.textContent).toMatch(/could not play/i);
    expect(c.querySelector("[data-walkie-unlock]")).not.toBeNull();
    expect(rig.acks.some((a) => a.kind === "delivered")).toBe(true);
    expect(rig.acks.some((a) => a.kind === "failed" && a.stage === "playback")).toBe(true);
    expect(rig.acks.some((a) => a.kind === "played")).toBe(false);
    expect(rig.channel.sendPlayed).not.toHaveBeenCalled();
  });
});
