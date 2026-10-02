// The two header buttons that open the two menus: the nine-dot LAUNCHER (every
// screen TAOS has) and the AVATAR (History, the guide, About, Sign out).
//
// They were one button until the nav restructure — a "More" menu holding four
// screens and four account items — and the split is why this file now talks
// about two triggers. The rule below is unchanged and is about the launcher.
//
// It used to draw the first letter of the signed-in email. On Tom's account
// (xdrabbit@) that letter is X, so the control that OPENS the menu was wearing
// the universal symbol for close/delete. Liz, taking the app to strangers on
// 8/30: they read it as "remove this" and would not touch it. It was never
// only Tom — any email whose first alphanumeric is an x drew the same button,
// and an email with none at all fell back to a person glyph, so what the
// trigger looked like depended on who was signed in.
//
// The rule this file pins: the CLOSED launcher trigger is the nine-dot apps
// grid, the OPEN one is an X, and neither is derived from the account. A first
// impression should not be a function of whose phone it is.
//
// The avatar beside it IS derived from the account, and that is not a
// regression of the above — it is the distinction the rule was always about. A
// DISCLOSURE wearing a dismissal glyph is what strangers refused to tap. An
// avatar is supposed to say whose phone this is; that is the whole convention,
// and it never swaps to an X. The last describe block pins that split.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyFor, ENGLISH } from "@/lib/chrome/copy";

const SHELL = "components/TranslatorShell.tsx";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Source minus commentary — this very file's rationale lives in a comment
 *  block up there in the shell, and a mention is not a rendered glyph. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/**
 * A trigger button: from the `onClick` that toggles its menu to the closing
 * `</button>`. Sliced rather than pattern-matched so the assertions below are
 * about THAT button and cannot be satisfied by the Share icon next to it,
 * which is also a round icon-only button full of circles — nor, now, by the
 * other trigger.
 */
function buttonToggling(setter: string): string {
  const source = code(SHELL);
  const start = source.indexOf(`${setter}((o) => !o)`);
  expect(start, `${setter} trigger not found`).toBeGreaterThan(-1);
  const open = source.lastIndexOf("<button", start);
  const end = source.indexOf("</button>", start);
  return source.slice(open, end);
}

/** The nine-dot launcher. */
function trigger(): string {
  return buttonToggling("setGridMenuOpen");
}

/** The identity chip. */
function avatar(): string {
  return buttonToggling("setAccountMenuOpen");
}

describe("the launcher trigger invites rather than dismisses", () => {
  it("draws nine dots when the menu is closed", () => {
    // Nine, not "some": eight is a ring, and the grid only reads as "apps"
    // at three-by-three.
    const t = trigger();
    const grid = t.slice(0, t.indexOf('gridMenuOpen ? "opacity-100"'));
    expect(grid.match(/<circle /g) ?? []).toHaveLength(9);
    // And that block is the one shown while CLOSED.
    expect(grid).toContain('gridMenuOpen ? "opacity-0" : "opacity-100"');
  });

  it("draws an X only when the menu is open", () => {
    const t = trigger();
    // The X path exists...
    expect(t).toMatch(/M6 6l12 12M18 6L6 18/);
    // ...and the half of the button holding it is the half that lights up on
    // open. If these ever swap, the stranger meets an X again.
    const xHalf = t.slice(t.indexOf("M6 6l12 12M18 6L6 18") - 600, t.indexOf("M6 6l12 12M18 6L6 18"));
    expect(xHalf).toContain('gridMenuOpen ? "opacity-100" : "opacity-0"');
  });

  it("never derives the LAUNCHER from the signed-in email", () => {
    // The actual defect, and the half of it that still holds after the nav
    // split: no initial, no first-letter arithmetic on `email`, no per-account
    // fallback glyph on the control that discloses the app's screens.
    //
    // The blanket "avatarInitial appears nowhere in the file" this used to
    // assert has become "appears nowhere in THIS button" — the avatar chip is
    // a real identity control now and is allowed to be an initial. Which
    // button is which is exactly what the slice above is for.
    const t = trigger();
    expect(t).not.toContain("avatarInitial");
    expect(t).not.toContain("email");
  });

  it("swaps the two glyphs in place, so the header cannot reflow", () => {
    // Both SVGs are absolutely positioned inside one fixed 16px box and
    // cross-faded. A conditional that renders one OR the other would pass the
    // tests above and still jump the row while the menu opens.
    const t = trigger();
    expect(t).toContain('<span className="relative block h-4 w-4">');
    expect(t.match(/absolute inset-0 h-4 w-4 transition-opacity/g) ?? []).toHaveLength(2);
  });
});

// "In both languages" used to mean ONE string carrying both ("All screens ·
// Pantallas"). Since the nav reached lib/chrome/copy.ts it means each phone
// reads its owner's language, and BOTH languages are in the table — which is
// what the last case here checks, so the claim is still pinned, not dropped.
describe("the trigger says what it does, in both languages", () => {
  it("offers All screens while closed and Close menu while open", () => {
    const t = trigger();
    expect(t).toContain("gridMenuOpen ? nav.navCloseMenu : nav.navAllScreens");
    // Both the screen reader and the tooltip, not one or the other.
    expect(t.match(/gridMenuOpen \? nav\.navCloseMenu : nav\.navAllScreens/g) ?? []).toHaveLength(2);
    expect(t).toContain("aria-label=");
    expect(t).toContain("title=");
  });

  it("keeps the menu itself labelled", () => {
    expect(code(SHELL)).toContain("aria-label={nav.navAllScreens}");
    expect(code(SHELL)).toContain("aria-label={nav.navAccount}");
  });

  it("has every header label in English AND Spanish, one language per string", () => {
    const es = copyFor("es");
    const keys = (Object.keys(ENGLISH) as Array<keyof typeof ENGLISH>).filter((k) => k.startsWith("nav"));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(code(SHELL), `${k} is in the table but not on the header`).toContain(`nav.${k}`);
      expect(ENGLISH[k]).not.toContain(" · ");
      expect(es[k]).not.toContain(" · ");
    }
    // Spanish is really there, not English falling through. ("Chat" is the
    // one word the two languages share, so it has no key — see copy.ts.)
    for (const k of keys) expect(es[k], k).not.toBe(ENGLISH[k]);
    // And the header no longer hard-codes a doubled label anywhere in it.
    const src = code(SHELL);
    const header = src.slice(src.indexOf("<header"), src.indexOf("</header>"));
    const doubled = (header.match(/(aria-label|title)="[^"]* · [^"]*"/g) ?? []).filter(
      (m) => !m.includes("Share TAOS")
    );
    expect(doubled).toEqual([]);
  });

  it("still announces itself as a menu button", () => {
    // aria-haspopup + aria-expanded are what tell a screen reader this is a
    // disclosure and not a link. The label rewrite must not drop them.
    const t = trigger();
    expect(t).toContain('aria-haspopup="menu"');
    expect(t).toContain("aria-expanded={gridMenuOpen}");
  });
});

describe("the menu still says who is signed in", () => {
  it("shows the email inside the account menu, not in a tooltip", () => {
    // `title={email}` used to be the only place the account appeared, and a
    // tooltip needs a mouse — on the phone this app is built for, it never
    // rendered at all. Sign out lives in this menu; the account it signs out
    // of has to be visible in it.
    const menu = code(SHELL);
    const start = menu.indexOf("aria-label={nav.navAccount}");
    expect(start).toBeGreaterThan(-1);
    const body = menu.slice(start, menu.indexOf("nav.navSignOut", start));
    expect(body).toContain("{email}");
  });
});

describe("the avatar is identity, and is never asked to mean close", () => {
  it("draws the account's initial, with a person glyph when there is none", () => {
    // An initial is the convention, and the fallback matters: an empty circle
    // or a "?" both read as an error state on a first impression.
    const a = avatar();
    expect(a).toContain("{avatarInitial ?? (");
    expect(code(SHELL)).toContain("const avatarInitial =");
  });

  it("never swaps to an X the way the launcher does", () => {
    // #45's finding, kept honest across the split: an X on Tom's account meant
    // "close/delete" to every stranger Liz handed the phone to. The launcher
    // earns its X because it genuinely toggles closed. The avatar shows open
    // state with a ring instead, so the glyph never changes meaning.
    const a = avatar();
    expect(a).not.toMatch(/M6 6l12 12M18 6L6 18/);
    expect(a).toContain("ring-2 ring-amber-300/60");
  });

  it("says what it is, in both languages, and announces itself as a menu", () => {
    const a = avatar();
    expect(a).toContain("accountMenuOpen ? nav.navCloseMenu : nav.navAccount");
    expect(a).toContain('aria-haspopup="menu"');
    expect(a).toContain("aria-expanded={accountMenuOpen}");
  });

  it("holds the account items and no screens", () => {
    // The split this whole restructure is for. /vision is a SCREEN and used to
    // live in here, which is why /guide had to tell readers that the photo
    // translator was in "the account menu".
    const src = code(SHELL);
    const start = src.indexOf("aria-label={nav.navAccount}", src.indexOf('role="menu"'));
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("<nav", start));
    for (const account of ["{nav.navHistory}", "{nav.navGuide}", "{nav.navAbout}", "{nav.navSignOut}"]) {
      expect(body).toContain(account);
    }
    for (const screen of ["/vision", "/live", "/chat", "/tabletop", "/translate", "/call", "/fast", "/video", "/tutor", "/study"]) {
      expect(body).not.toContain(`href="${screen}"`);
    }
  });
});
