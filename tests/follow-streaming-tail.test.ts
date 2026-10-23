// @vitest-environment jsdom
//
// Follow the tail of the streaming segment (Tom, 10/23). On Tabletop a long
// translation ran past the bottom of its pane while it was still being
// written, and the reader had to scroll to find the live words. The decided
// behavior, pinned here against a mocked scroll box (jsdom has no layout):
//
//   - streaming while the reader is at the bottom → the box tracks its end;
//   - the reader scrolled up → their place is kept and ↓ is offered;
//   - tapping ↓, or scrolling back down, resumes following;
//   - the segment finalizes → the box stops moving;
//   - a rotated pane is the same logic — the DOM bottom is that reader's tail.
//
// Reading order is NOT reversed anywhere (the newest-at-top #100 was dropped).
import { afterEach, describe, expect, it } from "vitest";
import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { JumpToTail, useFollowTail } from "@/components/FollowTail";

afterEach(cleanup);

// A scroll box whose content height is whatever the test says it is.
function fakeLayout(el: HTMLElement, clientHeight = 300) {
  let scrollHeight = clientHeight;
  let scrollTop = 0;
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    }
  });
  return {
    grow(px: number) {
      scrollHeight += px;
    },
    // What a finger does: move, then the browser fires `scroll`.
    userScrollTo(v: number) {
      el.scrollTop = v;
      fireEvent.scroll(el);
    },
    get bottom() {
      return scrollHeight - clientHeight;
    }
  };
}

let layout: ReturnType<typeof fakeLayout> | null = null;
let setText: (s: string) => void = () => {};
let setStreaming: (b: boolean) => void = () => {};

function Pane({ rotated = false }: { rotated?: boolean }) {
  const [text, _setText] = useState("");
  const [streaming, _setStreaming] = useState(true);
  setText = _setText;
  setStreaming = _setStreaming;
  const tail = useFollowTail<HTMLDivElement>(streaming, text);
  const ref = (el: HTMLDivElement | null) => {
    if (el && !layout) layout = fakeLayout(el);
    tail.ref(el);
  };
  return createElement(
    "section",
    { className: rotated ? "rotate-180" : "" },
    createElement("div", { ref, "data-testid": "box" }, text),
    createElement(JumpToTail, { show: tail.detached, onJump: tail.jumpToTail })
  );
}

// One chunk of streamed text: the content grows, then React renders it.
function chunk(s: string, px = 120) {
  act(() => {
    layout!.grow(px);
    setText(s);
  });
}

const jump = () => document.querySelector("[data-jump-to-tail]") as HTMLButtonElement | null;
const box = () => screen.getByTestId("box");

function mount(rotated = false) {
  layout = null;
  render(createElement(Pane, { rotated }));
}

describe("useFollowTail", () => {
  for (const rotated of [false, true]) {
    describe(rotated ? "rotated pane (top of the table)" : "upright pane", () => {
      it("tracks the end of the text while streaming at the bottom", () => {
        mount(rotated);
        chunk("Hola");
        expect(box().scrollTop).toBe(layout!.bottom);
        chunk("Hola, ¿cómo");
        chunk("Hola, ¿cómo estás hoy?");
        expect(box().scrollTop).toBe(layout!.bottom);
        expect(box().scrollTop).toBeGreaterThan(0);
        expect(jump()).toBeNull();
      });

      it("keeps the reader's place when they scrolled up, and offers ↓", () => {
        mount(rotated);
        chunk("a");
        chunk("ab");
        layout!.userScrollTo(10);
        chunk("abc");
        chunk("abcd");
        expect(box().scrollTop).toBe(10);
        expect(jump()).not.toBeNull();
        expect(jump()!.textContent).toBe("↓");
      });

      it("tapping ↓ jumps to the tail and resumes following", () => {
        mount(rotated);
        chunk("a");
        chunk("ab");
        layout!.userScrollTo(0);
        chunk("abc");
        act(() => {
          fireEvent.click(jump()!);
        });
        expect(box().scrollTop).toBe(layout!.bottom);
        expect(jump()).toBeNull();
        chunk("abcd");
        expect(box().scrollTop).toBe(layout!.bottom);
      });

      it("scrolling back to the bottom resumes following", () => {
        mount(rotated);
        chunk("a");
        chunk("ab");
        layout!.userScrollTo(0);
        chunk("abc");
        expect(jump()).not.toBeNull();
        act(() => layout!.userScrollTo(layout!.bottom));
        expect(jump()).toBeNull();
        chunk("abcd");
        expect(box().scrollTop).toBe(layout!.bottom);
      });

      it("stops moving the moment the segment finalizes", () => {
        mount(rotated);
        chunk("a");
        chunk("ab");
        const before = box().scrollTop;
        act(() => setStreaming(false));
        // The final text lands and grows the box — nothing follows it.
        chunk("ab — final");
        chunk("ab — final, longer");
        expect(box().scrollTop).toBe(before);
        expect(jump()).toBeNull();
      });
    });
  }

  it("hides ↓ when a detached segment finalizes", () => {
    mount();
    chunk("a");
    chunk("ab");
    layout!.userScrollTo(0);
    chunk("abc");
    expect(jump()).not.toBeNull();
    act(() => setStreaming(false));
    expect(jump()).toBeNull();
    expect(box().scrollTop).toBe(0);
  });
});

// The two screens use it on the boxes that actually stream, with Safari's
// own scroll anchoring off so the box isn't moved twice.
describe("wired into Tabletop and Live", () => {
  const tabletop = readFileSync("components/TabletopShell.tsx", "utf8");
  const live = readFileSync("components/LiveShell.tsx", "utf8");

  it("Tabletop: each pane has its own follower, the rotated one included", () => {
    expect(tabletop).toContain("renderPane(topLang, true, topTail)");
    expect(tabletop).toContain("renderPane(bottomLang, false, bottomTail)");
    expect(tabletop).toMatch(/ref=\{tail\.ref\} className="[^"]*overflow-y-auto[^"]*\[overflow-anchor:none\]/);
    expect(tabletop).toContain("<JumpToTail show={tail.detached} onJump={tail.jumpToTail} />");
  });

  it("Live: the streaming summary follows its own tail", () => {
    expect(live).toContain("useFollowTail(!!draft, draft)");
    expect(live).toMatch(/ref=\{draftTail\.ref\}\s+className="[^"]*overflow-y-auto[^"]*\[overflow-anchor:none\]/);
  });

  it("no reordering: Live still prepends, Tabletop panes still render oldest-first", () => {
    expect(live).toContain("...prev].slice(0, MAX_FEED)");
    expect(tabletop).not.toMatch(/NewestFirst/);
    expect(live).not.toMatch(/NewestFirst/);
  });
});
