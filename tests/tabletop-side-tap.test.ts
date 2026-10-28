// @vitest-environment jsdom
// /tabletop, field test 2026-10-28: with auto-detect on, a tap on EITHER pane
// starts an auto turn; a long-press (≥ 500 ms) forces that side for one turn.
// This mounts the real shell, drives the real pane button with pointer events,
// and reads what reached the brain: beginTurn's second argument is the auto
// pair for an auto turn and undefined for a forced one. The rules themselves
// are pinned in tests/tabletop-auto-detect.test.ts.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";

const brain = vi.hoisted(() => ({
  email: "xdrabbit@gmail.com",
  beginTurn: vi.fn((_d: unknown, _a?: unknown) => true),
  endTurn: vi.fn(async () => ({ heard: "", translation: "" })),
  stop: vi.fn(),
  start: vi.fn()
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/tabletop",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/lib/supabase", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase")>("@/lib/supabase");
  return {
    ...actual,
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: { access_token: "t", user: { id: "u", email: brain.email } } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
      }
    }
  };
});

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

vi.mock("@/lib/tabletop/openaiBrain", () => ({
  startOpenAIBrain: async (...args: unknown[]) => {
    brain.start(...args);
    return { kind: "openai", beginTurn: brain.beginTurn, endTurn: brain.endTurn, stop: brain.stop };
  }
}));

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(["en", "es"]));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
  brain.email = "xdrabbit@gmail.com";
  for (const f of [brain.beginTurn, brain.endTurn, brain.stop, brain.start]) f.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountTable(autoEnabled: boolean): Promise<HTMLElement> {
  const { TabletopShell } = await import("@/components/TabletopShell");
  const Shell = TabletopShell as ComponentType<{ autoEnabled?: boolean }>;
  const { container } = render(createElement(Shell, { autoEnabled }));
  await act(async () => {});
  await act(async () => {});
  return container;
}

/** The two pane buttons: [top (rotated, "es"), bottom ("en")]. */
function paneButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("section > button")) as HTMLButtonElement[];
}

async function tapPane(btn: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(btn, { clientX: 50, clientY: 50 });
    fireEvent.pointerUp(btn, { clientX: 50, clientY: 50 });
    fireEvent.click(btn);
  });
  await act(async () => {});
}

async function holdPane(btn: HTMLElement, move?: { x: number; y: number }): Promise<void> {
  vi.useFakeTimers();
  await act(async () => {
    fireEvent.pointerDown(btn, { clientX: 50, clientY: 50 });
    if (move) fireEvent.pointerMove(btn, { clientX: move.x, clientY: move.y });
    vi.advanceTimersByTime(520);
  });
  vi.useRealTimers();
  await act(async () => {
    fireEvent.pointerUp(btn, { clientX: 50, clientY: 50 });
    fireEvent.click(btn);
  });
  await act(async () => {});
  await act(async () => {});
}

describe("/tabletop pane gestures, mounted", () => {
  it("auto on: a tap on the TOP pane opens an auto turn", async () => {
    const c = await mountTable(true);
    expect(c.querySelector("[data-tabletop-hold-hint]")).not.toBeNull();
    const [top] = paneButtons(c);
    await tapPane(top);
    expect(brain.beginTurn).toHaveBeenCalledTimes(1);
    expect(brain.beginTurn.mock.calls[0][1]).toEqual({ a: "en", b: "es" });
    // The minted session asked for the auto prompt too.
    expect(brain.start.mock.calls[0][2]).toEqual({ auto: true });
  });

  it("auto on: a tap on the BOTTOM pane opens an auto turn", async () => {
    const c = await mountTable(true);
    await tapPane(paneButtons(c)[1]);
    expect(brain.beginTurn.mock.calls[0][1]).toEqual({ a: "en", b: "es" });
  });

  it("auto on: a long-press forces that side for ONE turn, then a tap is auto again", async () => {
    const c = await mountTable(true);
    const [top] = paneButtons(c);
    await holdPane(top);
    expect(brain.beginTurn).toHaveBeenCalledTimes(1);
    expect(brain.beginTurn.mock.calls[0][0]).toEqual({ source: "es", target: "en" });
    expect(brain.beginTurn.mock.calls[0][1]).toBeUndefined();
    // The click the browser sends when the finger lifts belongs to the hold:
    // it must not end the turn it just opened.
    expect(brain.endTurn).not.toHaveBeenCalled();
    // End the forced turn from its own lit button.
    await tapPane(paneButtons(c)[0]);
    expect(brain.endTurn).toHaveBeenCalledTimes(1);
    // Next tap: auto.
    await tapPane(paneButtons(c)[1]);
    expect(brain.beginTurn).toHaveBeenCalledTimes(2);
    expect(brain.beginTurn.mock.calls[1][1]).toEqual({ a: "en", b: "es" });
  });

  it("auto on: a press that moves past 10 px does nothing", async () => {
    const c = await mountTable(true);
    await holdPane(paneButtons(c)[0], { x: 50, y: 70 });
    expect(brain.beginTurn).not.toHaveBeenCalled();
  });

  it("auto off (no flag): a tap is today's forced turn and there is no hint", async () => {
    const c = await mountTable(false);
    expect(c.querySelector("[data-tabletop-hold-hint]")).toBeNull();
    await tapPane(paneButtons(c)[1]);
    expect(brain.beginTurn.mock.calls[0][0]).toEqual({ source: "en", target: "es" });
    expect(brain.beginTurn.mock.calls[0][1]).toBeUndefined();
  });

  it("a customer with the flag on: unchanged, forced", async () => {
    brain.email = "ana@test.invalid";
    const c = await mountTable(true);
    await tapPane(paneButtons(c)[0]);
    expect(brain.beginTurn.mock.calls[0][0]).toEqual({ source: "es", target: "en" });
    expect(brain.beginTurn.mock.calls[0][1]).toBeUndefined();
  });

  it("auto unchecked by a founder: a tap is forced again", async () => {
    const c = await mountTable(true);
    const box = c.querySelector("[data-tabletop-auto] input[type=checkbox]") as HTMLInputElement;
    await act(async () => {
      fireEvent.click(box);
    });
    expect(c.querySelector("[data-tabletop-hold-hint]")).toBeNull();
    await tapPane(paneButtons(c)[1]);
    expect(brain.beginTurn.mock.calls[0][1]).toBeUndefined();
  });
});
