// @vitest-environment jsdom
//
// Stop and Clear never scroll away (Tom, 2026-11-04). Follow-the-tail (#101)
// stays — oldest-first, the pane follows the segment being written — but
// with a long history the controls were a full scroll away. Now:
//
//   /live     STOP + Clear sit in a bar that is `sticky bottom-0` and the
//             LAST child of the scrolling column. Sticky-in-flow (not fixed)
//             means the bar reserves its own height at the end of the page,
//             so the feed can never end up under it, whatever the bar's
//             height is at the moment (the idle caption comes and goes).
//             The bar carries the safe-area inset itself; the page no longer
//             pads for it, so the bar sits flush on the home indicator.
//   /tabletop the page is 100dvh and does not scroll; each pane's talk
//             button is BELOW its scroll box, and the middle bar (the exit pill,
//             swap, engine, voice) is between the panes. Nothing to pin —
//             pinned here so nobody moves a button INTO a scroll box. The
//             pane ends get the inset of the edge they are drawn against.
//
// The newest-at-top idea (#100) is not used anywhere.
import { readFileSync } from "node:fs";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/x",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams()
}));

// Signed in, empty database — the same stand-in tests/exit-home-everywhere uses.
vi.mock("@/lib/supabase", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase")>("@/lib/supabase");
  const session = { access_token: "t", user: { id: "u1", email: "test@example.com" } };
  const empty = { data: [], error: null, count: 0 };
  const query: unknown = new Proxy(() => {}, {
    get: (_t, key) =>
      key === "then" ? (resolve: (v: unknown) => void) => resolve(empty) : () => query,
    apply: () => query
  });
  const channel: unknown = new Proxy(() => {}, {
    get: () => () => channel,
    apply: () => channel
  });
  return {
    ...actual,
    getProfile: async () => null,
    getMonthlyUsage: async () => ({ translations: 0, tutorSeconds: 0 }),
    listHistory: async () => [],
    supabase: {
      auth: {
        getSession: async () => ({ data: { session } }),
        getUser: async () => ({ data: { user: session.user } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signOut: async () => {}
      },
      from: () => query,
      rpc: () => query,
      channel: () => channel,
      removeChannel: () => {},
      storage: { from: () => query }
    }
  };
});

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SCROLL_BOX = "[overflow-anchor:none]";
const cls = (el: Element) => el.getAttribute("class") ?? "";

describe("/live: STOP and Clear are a sticky bottom bar", () => {
  const src = readFileSync("components/LiveShell.tsx", "utf8");

  it("renders the bar, pinned to the viewport bottom, above the home indicator", async () => {
    const { LiveShell } = await import("@/components/LiveShell");
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(createElement(LiveShell)));
    });
    const bar = container.querySelector("[data-live-controls]");
    expect(bar).not.toBeNull();
    expect(cls(bar!)).toMatch(/\bsticky\b/);
    expect(cls(bar!)).toMatch(/\bbottom-0\b/);
    expect(cls(bar!)).toContain("env(safe-area-inset-bottom)");
    // The primary control lives in it.
    const primary = Array.from(bar!.querySelectorAll("button")).find((b) =>
      /START LISTENING|STOP/.test(b.textContent ?? "")
    );
    expect(primary).toBeDefined();
  });

  it("is the last child of the scrolling column, so the feed can never end under it", async () => {
    const { LiveShell } = await import("@/components/LiveShell");
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(createElement(LiveShell)));
    });
    const bar = container.querySelector("[data-live-controls]")!;
    const column = bar.parentElement!;
    expect(column.lastElementChild).toBe(bar);
    // In flow, not fixed: a fixed bar would need the column to pad for it.
    expect(cls(bar)).not.toMatch(/\bfixed\b/);
    // The feed is an earlier sibling in the same column, not wrapped in a
    // scroll box of its own — the page scrolls, the bar sticks.
    const feed = container.querySelector("main ol, main section");
    expect(feed).not.toBeNull();
    expect(bar.contains(feed!)).toBe(false);
  });

  it("the bar, not the page, carries the bottom inset — it sits flush on the home indicator", async () => {
    const { LiveShell } = await import("@/components/LiveShell");
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(createElement(LiveShell)));
    });
    const main = container.querySelector("main")!;
    expect(cls(main)).not.toContain("safe-area-inset-bottom");
    expect(cls(main)).toContain("safe-area-inset-top");
  });

  it("Clear moved into the bar (one Clear, beside STOP) and is gone from the Concepts header", () => {
    const start = src.indexOf('data-live-controls=""');
    expect(start).toBeGreaterThan(0);
    const bar = src.slice(start, src.indexOf("</section>", start));
    expect(bar).toContain("onClick={clearAll}");
    expect(bar).toContain("onClick={handlePrimary}");
    expect(src.split("onClick={clearAll}").length - 1).toBe(1);
    // Still only when there is something to clear.
    expect(bar).toMatch(/feed\.length > 0 \? \(\s*<button/);
  });

  it("the exit pill stays in the header, and the draft card still follows its own tail", () => {
    const header = src.slice(src.indexOf("<header"), src.indexOf("</header>"));
    expect(header).toContain("<ExitHome");
    expect(src).toContain("useFollowTail(!!draft, draft)");
    expect(src).not.toMatch(/NewestFirst/);
  });
});

describe("/tabletop: the controls are outside the scroll boxes", () => {
  const src = readFileSync("components/TabletopShell.tsx", "utf8");

  it("the page does not scroll; both talk buttons and the middle bar are outside any scroll box", async () => {
    const { TabletopShell } = await import("@/components/TabletopShell");
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(createElement(TabletopShell)));
    });
    const main = container.querySelector("main")!;
    expect(cls(main)).toContain("h-[100dvh]");
    expect(cls(main)).toMatch(/\boverflow-hidden\b/);

    const talk = container.querySelectorAll("[data-tabletop-talk]");
    expect(talk.length).toBe(2);
    for (const b of Array.from(talk)) {
      expect(b.closest(`[class*="${SCROLL_BOX}"]`)).toBeNull();
    }
    const controls = container.querySelector("[data-tabletop-controls]")!;
    expect(controls).not.toBeNull();
    expect(controls.closest(`[class*="${SCROLL_BOX}"]`)).toBeNull();
    // Both panes still have their own scroll box (follow-the-tail, #101).
    expect(container.querySelectorAll(`[class*="${SCROLL_BOX}"]`).length).toBe(2);
    // Each pane: scroll box first, then the talk button after it — never inside.
    for (const b of Array.from(talk)) {
      const pane = b.closest("section")!;
      const box = pane.querySelector(`[class*="${SCROLL_BOX}"]`)!;
      expect(box.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("each pane end is padded for the edge it is drawn against", () => {
    expect(src).toContain('"rotate-180 pb-[calc(1rem+env(safe-area-inset-top))]"');
    expect(src).toContain('"pb-[calc(1rem+env(safe-area-inset-bottom))]"');
    expect(src).not.toMatch(/NewestFirst/);
  });
});
