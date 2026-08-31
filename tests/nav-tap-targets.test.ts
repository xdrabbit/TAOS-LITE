// The fence for the header that ate touches.
//
// Tom, 8/31, on the Droid: reaching Call through Together ▾ took two or three
// touches, every time. It was read as an event race — an outside-click handler
// closing a menu before the item's onClick landed — and it was not. Both menus
// already closed on an outside `pointerdown` with a proper containment check,
// and a browser walking them found open-then-select in exactly two touches
// whenever the controls were reachable. The bug was that they were not:
//
//   viewport   nav content   "More · Más" trigger    elementFromPoint
//                 ends at      off-screen by          at its centre
//     390 px      405.9 px        15.9 px               NOTHING
//     360 px      405.9 px        45.9 px               NOTHING
//     320 px      405.9 px        85.9 px               NOTHING
//
// The row of pills had outgrown the phone. Two tap-eaters came out of that one
// number: the grid trigger was laid out past the right edge of the glass, and
// document.scrollWidth (406) exceeded the viewport, which makes the whole page
// pannable — and on a pannable page a touch that drifts sideways is a PAN, so
// the browser dispatches no click at all and the row slides out from under the
// next attempt. Measured: 20 px of drift scrolled the page 7 px and fired
// nothing. That is the two-or-three touches.
//
// tests/live-fire/menu-tap-browser-check.mjs is what measured all of the
// above and is the thing to re-run when this header changes; it needs Chrome,
// so CI cannot. This file pins the same fix in what CI can read — the
// structural choices that keep the header off the edge, since a hand-tuned
// width would not survive the next screen anyone adds. This row has already
// grown back once: the Together menu was created on 8/19 to fix exactly this
// overflow, and by 8/30 it measured 406 px again.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SHELL = "components/TranslatorShell.tsx";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Source minus commentary — the rationale above is repeated in the shell, and
 *  a comment describing a class name is not a class name. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** The header element, opening tag to `</header>`. */
function header(): string {
  const source = code(SHELL);
  const start = source.indexOf("<header");
  expect(start, "no <header> in the shell").toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("</header>", start));
}

describe("the header cannot push a control off the phone", () => {
  it("lays the brand and the screens out as rows, not one long line", () => {
    // `flex-col` is the whole reason the row cannot overflow: the pills get a
    // line of their own instead of competing with the title and two icons for
    // one. Six controls plus a wordmark do not fit 320 px on one line and
    // never will.
    expect(header()).toMatch(/<header className="relative flex flex-col gap-2">/);
  });

  it("lets the pill row wrap rather than run off the edge", () => {
    // The backstop for whatever the next PR adds. A wrapping row can put a
    // pill on a second line; it cannot put one past the right edge, and it
    // cannot make document.scrollWidth exceed the viewport — which is what
    // made the page pannable and the touches unrepeatable.
    const nav = header().slice(header().indexOf("<nav"));
    expect(nav).toContain("flex-wrap");
  });

  it("keeps Share and More out of the row that grows", () => {
    // Every screen TAOS has added since 8/19 arrived as a pill, and the More
    // trigger riding on the end of that row is what carried it off the phone.
    // These two are not screens, so they sit with the wordmark instead, where
    // nothing can push them.
    const h = header();
    const rowOne = h.slice(0, h.indexOf("<nav"));
    expect(rowOne).toContain('aria-label="Share TAOS / Compartir TAOS"');
    expect(rowOne).toContain('aria-haspopup="menu"');
    expect(rowOne).toContain("accountMenuRef");
    // ...and the pill row holds only screens. Together ▾ stays here — it is a
    // disclosure for three of them, so it grows with the row it belongs to.
    const nav = h.slice(h.indexOf("<nav"));
    expect(nav).not.toContain("Share TAOS");
    expect(nav).not.toContain("accountMenuRef");
  });
});

describe("a dropdown opens below the header, not on top of the nav", () => {
  it("anchors both menus to the header", () => {
    // The trap this walked into once: a menu positioned against its own
    // trigger drops onto whatever is under that trigger, and with the nav in
    // two rows that is the pills. A touch aimed at Together ▾ then lands on a
    // menu item — not a dead tap, a WRONG one. Anchoring to the header makes
    // where a menu opens independent of where its trigger wrapped to.
    const h = header();
    expect(h).toMatch(/<header className="relative /);
    expect(h).toContain("<div ref={accountMenuRef}>");
    expect(h).toContain("<div ref={togetherMenuRef}>");
    // Neither wrapper may become a positioning context again.
    expect(h).not.toMatch(/ref=\{accountMenuRef\} className="relative"/);
    expect(h).not.toMatch(/ref=\{togetherMenuRef\} className="relative"/);
  });

  it("still drops them from the top of something, downward", () => {
    expect(header().match(/absolute right-0 top-full/g) ?? []).toHaveLength(2);
  });
});

describe("nothing in the nav is smaller than a fingertip", () => {
  it("gives the two icon triggers 44px", () => {
    // They were 32x32 (h-8 w-8) — the two smallest controls on the screen and
    // the two you must hit precisely, since neither has a label to aim at.
    const h = header();
    expect(h).not.toContain("h-8 w-8");
    expect(h.match(/flex h-11 w-11 items-center justify-center rounded-full/g) ?? [])
      .toHaveLength(2);
  });

  it("gives every menu item 44px of height", () => {
    // py-2.5 on a text-sm line is 40px. The items are the easy half of this —
    // they are full-menu-width already — but 40 is still under the floor.
    const h = header();
    const items = h.match(/role="menuitem"/g) ?? [];
    expect(items.length).toBeGreaterThan(4);
    // Every menu item, plus every pill in the row below (see the next test).
    const nav = h.slice(h.indexOf("<nav"));
    const pills = nav.match(/rounded-full border border-amber-300\/30/g) ?? [];
    expect(h.match(/min-h-\[44px\]/g) ?? []).toHaveLength(items.length + pills.length);
  });

  it("gives the SCREEN PILLS 44px too, which #53 claimed and did not do", () => {
    // The residual from that PR, and the one that mattered most on a phone.
    // It raised the two icon triggers to 44x44 and floored every menu item,
    // and its description said "every control ... ≥44 px" — but the pills
    // stayed at px-3 py-1.5 on a text-xs line, which lays out 28px tall. They
    // are the row a thumb reaches for most, and 28px means the touch has to
    // land within 14px vertically of centre; #53's own rig measured a
    // reaching thumb drifting 12-20px.
    //
    // It was invisible because the browser rig was passed `min: 0` for these
    // four and 44 for everything else. It asks for 44 across the board now.
    const nav = header().slice(header().indexOf("<nav"));
    const pills = nav.match(/className="[^"]*rounded-full border border-amber-300\/30[^"]*"/g) ?? [];
    // Live, Call, Together ▾, Translate.
    expect(pills.length).toBeGreaterThanOrEqual(4);
    for (const pill of pills) {
      expect(pill).toContain("min-h-[44px]");
      // min-height does nothing to an inline element, and centres nothing
      // without it: the floor has to come with a box that can grow.
      expect(pill).toContain("inline-flex");
      expect(pill).toContain("items-center");
    }
  });
});

describe("closing a menu is a containment check, not a suppressed event", () => {
  // Not the bug, but the thing everyone reaches for first when a menu eats a
  // tap — and the shape that WOULD have caused it. Pinned so a future fix for
  // some other symptom cannot reintroduce it.
  it("closes on an outside pointerdown by asking whether the target is inside", () => {
    const source = code(SHELL);
    for (const ref of ["accountMenuRef", "togetherMenuRef"]) {
      expect(source).toContain(`${ref}.current && !${ref}.current.contains(e.target as Node)`);
    }
    expect(source.match(/document\.addEventListener\("pointerdown"/g) ?? []).toHaveLength(2);
  });

  it("never reaches for stopPropagation to protect an item's tap", () => {
    // A containment check that is right does not need one, and one that is
    // wrong is only hidden by it.
    expect(code(SHELL)).not.toContain("stopPropagation");
  });

  it("wires the listeners only while a menu is open", () => {
    const source = code(SHELL);
    expect(source).toContain("if (!accountMenuOpen) return;");
    expect(source).toContain("if (!togetherMenuOpen) return;");
    expect(source.match(/document\.removeEventListener\("pointerdown"/g) ?? []).toHaveLength(2);
  });
});

describe("Call is one touch for a founder and invisible to everyone else", () => {
  it("is a top-level pill, not a menu entry", () => {
    // Tom and Liz use /call daily; it was two touches behind Together ▾.
    const h = header();
    const nav = h.slice(h.indexOf("<nav"));
    expect(nav).toContain('href="/call"');
    // In the pill row, not in either dropdown.
    const togetherMenu = h.slice(h.indexOf('aria-label="Together"'));
    expect(togetherMenu.slice(0, togetherMenu.indexOf("</div>"))).not.toContain('href="/call"');
  });

  it("appears exactly once, behind the same guard every /call surface asks", () => {
    // One entry per screen is what keeps tests/nav-completeness.test.ts a
    // fence rather than a headcount, and callVisible is callVisibleTo(email) —
    // the same question the page gate and POST /api/call/realtime ask.
    const h = header();
    expect(h.match(/href="\/call"/g) ?? []).toHaveLength(1);
    const at = h.indexOf('href="/call"');
    expect(h.slice(0, at)).toMatch(/\{callVisible \? \($/m);
  });
});
