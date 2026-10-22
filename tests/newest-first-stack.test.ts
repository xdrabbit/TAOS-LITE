// @vitest-environment jsdom
//
// /live and /tabletop are stacks, not teleprompters (Tom, 2026-10-22):
//
//   "The new stuff stays at the top where it's visible, and the old stuff
//    gets pushed down — like a stack, last in, first out. As something new
//    comes in, the old stuff gets pushed down, ultimately off screen, but
//    everything that's fresh stays. Not a teleprompter. A stack."
//
// Before this, /tabletop's pane grew downward and ran off the bottom, so the
// person reading it had to chase it — the TTS log showed /tabletop used 5
// times against ~2,000 home lines in the same 15 days.
//
// jsdom has no layout, so the scroll box is given one: every
// `[data-stack-item]` is 100px tall (or `data-h`), stacked in document
// order, and scrollTop is a plain number the component can read and write.
// That is enough to pin the two promises: at the top you STAY at the top,
// and down in the history the line you are reading does not move.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NewestFirstStack } from "@/components/NewestFirstStack";
import type { TabletopBrainEvents } from "@/lib/tabletop/brain";
import type { AmbientEvents } from "@/lib/live/ambient";
import { copyFor } from "@/lib/chrome/copy";

// ── A layout for jsdom ─────────────────────────────────────────────────────
const scrollTops = new WeakMap<Element, number>();

function itemHeight(el: Element): number {
  return Number(el.getAttribute("data-h") ?? 100);
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      scrollTops.set(this, v);
    }
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-stack-item") ? itemHeight(this) : 0;
    }
  });
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      const box = this.closest("[data-testid='newest-first-stack']");
      if (!box || !this.hasAttribute("data-stack-item")) return 0;
      let top = 0;
      for (const el of Array.from(box.querySelectorAll("[data-stack-item]"))) {
        if (el === this) return top;
        top += itemHeight(el);
      }
      return top;
    }
  });
});

/** A list of named items, newest first, with buttons to add one on top. */
function Harness({ initial }: { initial: string[] }): JSX.Element {
  const [items, setItems] = useState(initial);
  const [partial, setPartial] = useState("");
  return createElement(
    "div",
    null,
    createElement("button", {
      onClick: () => setItems((xs) => [`n${xs.length}`, ...xs])
    }, "push"),
    createElement("button", { onClick: () => setPartial((p) => p + "x") }, "grow"),
    createElement(
      NewestFirstStack,
      { contentKey: `${items.length}:${partial.length}` },
      partial
        ? createElement("div", { "data-stack-item": "", "data-h": 100 + partial.length * 10 }, partial)
        : null,
      ...items.map((x) => createElement("div", { key: x, "data-stack-item": "" }, x))
    )
  );
}

function box(): HTMLElement {
  return screen.getByTestId("newest-first-stack");
}

function scrollTo(top: number): void {
  const el = box();
  el.scrollTop = top;
  fireEvent.scroll(el);
}

afterEach(() => cleanup());

describe("NewestFirstStack — the scroll lock", () => {
  it("a new item while at the top: stays at the top, no affordance", () => {
    render(createElement(Harness, { initial: ["b", "a"] }));
    expect(box().scrollTop).toBe(0);
    fireEvent.click(screen.getByText("push"));
    expect(box().scrollTop).toBe(0);
    expect(screen.queryByTestId("stack-back-to-top")).toBeNull();
    // A streaming item growing in place at the top doesn't move it either.
    fireEvent.click(screen.getByText("grow"));
    fireEvent.click(screen.getByText("grow"));
    expect(box().scrollTop).toBe(0);
  });

  it("a little rubber-band slop near the top still counts as the top", () => {
    render(createElement(Harness, { initial: ["b", "a"] }));
    scrollTo(5);
    fireEvent.click(screen.getByText("push"));
    expect(box().scrollTop).toBe(0);
  });

  it("never writes over an iOS overscroll (negative scrollTop)", () => {
    render(createElement(Harness, { initial: ["b", "a"] }));
    scrollTo(-30);
    fireEvent.click(screen.getByText("push"));
    expect(box().scrollTop).toBe(-30);
  });

  it("a new item while reading history: the line being read does not move, and ↑ appears", () => {
    render(createElement(Harness, { initial: ["d", "c", "b", "a"] }));
    // Reading "c" (offsetTop 100), 20px into it.
    scrollTo(120);
    const reading = screen.getByText("c");
    const onScreen = reading.offsetTop - box().scrollTop;
    fireEvent.click(screen.getByText("push"));
    expect(reading.offsetTop).toBe(200); // pushed down by the new item…
    expect(reading.offsetTop - box().scrollTop).toBe(onScreen); // …and so was the view.
    expect(screen.getByTestId("stack-back-to-top")).toBeTruthy();
  });

  it("a streaming item growing above the reader doesn't move their line either", () => {
    render(createElement(Harness, { initial: ["c", "b", "a"] }));
    fireEvent.click(screen.getByText("grow")); // partial: 110px at the top
    scrollTo(150); // in "c" (110..210)
    const reading = screen.getByText("c");
    const onScreen = reading.offsetTop - box().scrollTop;
    fireEvent.click(screen.getByText("grow"));
    fireEvent.click(screen.getByText("grow"));
    expect(reading.offsetTop - box().scrollTop).toBe(onScreen);
  });

  it("tapping ↑ returns to the top, and the next item keeps it there", () => {
    render(createElement(Harness, { initial: ["c", "b", "a"] }));
    scrollTo(150);
    fireEvent.click(screen.getByText("push"));
    fireEvent.click(screen.getByTestId("stack-back-to-top"));
    expect(box().scrollTop).toBe(0);
    expect(screen.queryByTestId("stack-back-to-top")).toBeNull();
    fireEvent.click(screen.getByText("push"));
    expect(box().scrollTop).toBe(0);
  });

  it("scrolling back to the top by hand does the same as tapping ↑", () => {
    render(createElement(Harness, { initial: ["c", "b", "a"] }));
    scrollTo(150);
    fireEvent.click(screen.getByText("push"));
    expect(screen.getByTestId("stack-back-to-top")).toBeTruthy();
    scrollTo(0);
    expect(screen.queryByTestId("stack-back-to-top")).toBeNull();
    fireEvent.click(screen.getByText("push"));
    expect(box().scrollTop).toBe(0);
  });

  it("turns off the browser's own scroll anchoring so every engine does the same thing", () => {
    render(createElement(Harness, { initial: ["a"] }));
    expect(box().style.overflowAnchor).toBe("none");
  });
});

// ── /tabletop, through the real screen ─────────────────────────────────────
// Only the brain and the network are fakes; the pane, its stack and the turn
// flow are the shipped TabletopShell.

let brainEvents: TabletopBrainEvents | null = null;
let nextResult = { heard: "", translation: "" };
const fakeBrain = vi.fn(async (events: TabletopBrainEvents) => {
  brainEvents = events;
  return {
    beginTurn: () => true,
    endTurn: async () => ({ ...nextResult }),
    stop: () => {}
  };
});

vi.mock("@/lib/tabletop/openaiBrain", () => ({
  startOpenAIBrain: (...a: unknown[]) => (fakeBrain as unknown as (...x: unknown[]) => unknown)(...a)
}));
vi.mock("@/lib/tabletop/geminiBrain", () => ({ startGeminiBrain: vi.fn() }));
vi.mock("@/lib/tabletop/audio", () => ({ ensureTabletopAudioContext: () => {} }));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }
}));
vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));
vi.mock("@/lib/tts/speech", () => ({
  requestSpeech: async () => null,
  isTextOnlyLanguage: () => false,
  TEXT_ONLY_TITLE: "Text only"
}));
let ambientEvents: AmbientEvents | null = null;
vi.mock("@/lib/live/ambient", () => ({
  startAmbientLive: async (_cfg: unknown, events: AmbientEvents) => {
    ambientEvents = events;
    events.onState?.("connected");
    return { stop: async () => {}, setMuted: () => {} };
  }
}));
vi.mock("@/lib/wakeLock", () => ({ holdWake: () => {}, keepWake: () => () => {} }));

describe("/tabletop — each pane is a newest-first stack", () => {
  // Default pair is ["es", "en"]: the owner (bottom) is Spanish, the far end
  // (top, rotated) is English.
  const es = copyFor("es");
  const en = copyFor("en");

  beforeEach(() => {
    brainEvents = null;
    window.localStorage.clear();
  });

  function panes(): { top: HTMLElement; bottom: HTMLElement } {
    const [top, bottom] = Array.from(document.querySelectorAll("main > section")) as HTMLElement[];
    return { top, bottom };
  }

  function items(pane: HTMLElement): string[] {
    return Array.from(pane.querySelectorAll("[data-testid='pane-item']")).map(
      (el) => el.textContent ?? ""
    );
  }

  /** One full live turn from `side`, with streaming text along the way. */
  async function turn(pane: "top" | "bottom", heard: string, translation: string): Promise<void> {
    const tapLabel = pane === "top" ? en.tapToTalk : es.tapToTalk;
    const doneLabel = pane === "top" ? en.tapDone : es.tapDone;
    await act(async () => {
      fireEvent.click(panes()[pane].querySelector(":scope > button") as HTMLElement);
    });
    expect(panes()[pane].textContent).toContain(doneLabel);
    await act(async () => {
      brainEvents?.onHeard?.(heard);
      brainEvents?.onPartial?.(translation);
    });
    nextResult = { heard, translation };
    await act(async () => {
      fireEvent.click(panes()[pane].querySelector(":scope > button") as HTMLElement);
    });
    expect(panes()[pane].textContent).toContain(tapLabel);
  }

  it("newest turn on top, older ones pushed down — in both panes", async () => {
    const { TabletopShell } = await import("@/components/TabletopShell");
    render(createElement(TabletopShell));
    await act(async () => {});

    await turn("bottom", "uno", "one");
    await turn("top", "two", "dos");
    await turn("bottom", "tres", "three");

    // The top (English) pane reads the owner's turns as translations and
    // its own as what was heard — newest first.
    expect(items(panes().top).map((s) => s.replace(en.theySaid, "").replace(en.youSaid, ""))).toEqual([
      "three",
      "two",
      "one"
    ]);
    expect(items(panes().bottom).map((s) => s.replace(es.theySaid, "").replace(es.youSaid, ""))).toEqual([
      "tres",
      "dos",
      "uno"
    ]);
  });

  it("the turn in progress is the TOP item and grows in place", async () => {
    const { TabletopShell } = await import("@/components/TabletopShell");
    render(createElement(TabletopShell));
    await act(async () => {});
    await turn("bottom", "uno", "one");

    await act(async () => {
      fireEvent.click(panes().bottom.querySelector(":scope > button") as HTMLElement);
    });
    await act(async () => {
      brainEvents?.onHeard?.("dos y");
      brainEvents?.onPartial?.("two ");
    });
    expect(items(panes().top)[0]).toContain("two ");
    expect(items(panes().bottom)[0]).toContain("dos y");
    await act(async () => {
      brainEvents?.onHeard?.("dos y tres");
      brainEvents?.onPartial?.("and three");
    });
    expect(items(panes().top)[0]).toContain("two and three");
    expect(items(panes().top)[0]).toContain("▍");
    expect(items(panes().top)[1]).toContain("one"); // the old one, pushed down
    expect(items(panes().bottom)[0]).toContain("dos y tres");
    expect(items(panes().bottom)[1]).toContain("uno");
  });

  it("the far pane is rotated as a whole, so its DOM-first item is at the far reader's top", async () => {
    const { TabletopShell } = await import("@/components/TabletopShell");
    render(createElement(TabletopShell));
    await act(async () => {});
    await turn("bottom", "uno", "one");
    await turn("bottom", "dos", "two");

    const { top, bottom } = panes();
    // The whole section turns — not the list inside it — so "first in the
    // DOM" is "nearest the top edge" for the person across the table, the
    // same as it is for the owner.
    expect(top.className).toContain("rotate-180");
    expect(bottom.className).not.toContain("rotate-180");
    const stack = top.querySelector("[data-testid='newest-first-stack']") as HTMLElement;
    expect(stack.closest("section")).toBe(top);
    expect(stack.className).not.toContain("rotate");
    expect(stack.className).not.toContain("flex-col-reverse");
    expect(items(top)[0]).toContain("two");
    // And the stack starts at its top.
    expect(stack.scrollTop).toBe(0);
  });
});

// ── /live, through the real screen ─────────────────────────────────────────
describe("/live — the concept feed is a newest-first stack", () => {
  beforeEach(() => {
    ambientEvents = null;
    window.localStorage.clear();
  });

  function feedItems(): string[] {
    return Array.from(
      box().querySelectorAll("[data-stack-item]")
    ).map((el) => (el.textContent ?? "").replace(/^\d{1,2}:\d{2}(\s?[AP]M)?/, ""));
  }

  it("newest summary on top; the streaming one is the top item and grows in place", async () => {
    const { LiveShell } = await import("@/components/LiveShell");
    render(createElement(LiveShell));
    await act(async () => {
      fireEvent.click(screen.getByText("START LISTENING"));
    });
    await act(async () => {
      ambientEvents?.onSummaryDone?.("first");
      ambientEvents?.onSummaryDone?.("second");
      ambientEvents?.onSummaryDelta?.("thi");
    });
    expect(feedItems()[0]).toContain("thi▍");
    expect(feedItems().slice(1).map((s) => s.trim())).toEqual(["second", "first"]);
    await act(async () => {
      ambientEvents?.onSummaryDelta?.("rd");
      ambientEvents?.onSummaryDone?.("third");
    });
    expect(feedItems().map((s) => s.trim())).toEqual(["third", "second", "first"]);
    expect(box().scrollTop).toBe(0);
  });
});
