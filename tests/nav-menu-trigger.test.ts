// The header button that opens the More menu — Tutor, Video, Photo, History,
// the guide, About, Sign out.
//
// It used to draw the first letter of the signed-in email. On Tom's account
// (xdrabbit@) that letter is X, so the control that OPENS the menu was wearing
// the universal symbol for close/delete. Liz, taking the app to strangers on
// 8/30: they read it as "remove this" and would not touch it. It was never
// only Tom — any email whose first alphanumeric is an x drew the same button,
// and an email with none at all fell back to a person glyph, so what the
// trigger looked like depended on who was signed in.
//
// The rule this file pins: the CLOSED trigger is the nine-dot apps grid, the
// OPEN trigger is an X, and neither one is derived from the account. A first
// impression should not be a function of whose phone it is.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
 * The trigger button: from the `onClick` that toggles the menu to the closing
 * `</button>`. Sliced rather than pattern-matched so the assertions below are
 * about THIS button and cannot be satisfied by the Share icon next to it,
 * which is also a round icon-only button full of circles.
 */
function trigger(): string {
  const source = code(SHELL);
  const start = source.indexOf("setAccountMenuOpen((o) => !o)");
  expect(start, "account-menu trigger not found").toBeGreaterThan(-1);
  const open = source.lastIndexOf("<button", start);
  const end = source.indexOf("</button>", start);
  return source.slice(open, end);
}

describe("the More trigger invites rather than dismisses", () => {
  it("draws nine dots when the menu is closed", () => {
    // Nine, not "some": eight is a ring, and the grid only reads as "apps"
    // at three-by-three.
    const t = trigger();
    const grid = t.slice(0, t.indexOf('accountMenuOpen ? "opacity-100"'));
    expect(grid.match(/<circle /g) ?? []).toHaveLength(9);
    // And that block is the one shown while CLOSED.
    expect(grid).toContain('accountMenuOpen ? "opacity-0" : "opacity-100"');
  });

  it("draws an X only when the menu is open", () => {
    const t = trigger();
    // The X path exists...
    expect(t).toMatch(/M6 6l12 12M18 6L6 18/);
    // ...and the half of the button holding it is the half that lights up on
    // open. If these ever swap, the stranger meets an X again.
    const xHalf = t.slice(t.indexOf("M6 6l12 12M18 6L6 18") - 600, t.indexOf("M6 6l12 12M18 6L6 18"));
    expect(xHalf).toContain('accountMenuOpen ? "opacity-100" : "opacity-0"');
  });

  it("never derives the trigger from the signed-in email", () => {
    // The actual defect. No initial, no first-letter arithmetic on `email`,
    // and no per-account fallback glyph.
    const t = trigger();
    expect(t).not.toContain("avatarInitial");
    expect(t).not.toContain("email");
    expect(code(SHELL)).not.toContain("avatarInitial");
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

describe("the trigger says what it does, in both languages", () => {
  it("offers More · Más while closed and Close · Cerrar while open", () => {
    const t = trigger();
    expect(t).toContain('accountMenuOpen ? "Close menu · Cerrar menú" : "More · Más"');
    // Both the screen reader and the tooltip, not one or the other.
    expect(t.match(/accountMenuOpen \? "Close menu · Cerrar menú" : "More · Más"/g) ?? [])
      .toHaveLength(2);
    expect(t).toContain("aria-label=");
    expect(t).toContain("title=");
  });

  it("keeps the menu itself labelled, and bilingual", () => {
    expect(code(SHELL)).toContain('aria-label="More · Más"');
  });

  it("still announces itself as a menu button", () => {
    // aria-haspopup + aria-expanded are what tell a screen reader this is a
    // disclosure and not a link. The label rewrite must not drop them.
    const t = trigger();
    expect(t).toContain('aria-haspopup="menu"');
    expect(t).toContain("aria-expanded={accountMenuOpen}");
  });
});

describe("the menu still says who is signed in", () => {
  it("shows the email inside the menu, now that the trigger does not", () => {
    // `title={email}` used to be the only place the account appeared, and a
    // tooltip needs a mouse — on the phone this app is built for, it never
    // rendered at all. Sign out lives in this menu; the account it signs out
    // of has to be visible in it.
    const menu = code(SHELL);
    const start = menu.indexOf('aria-label="More · Más"');
    const body = menu.slice(start, menu.indexOf("Sign out", start));
    expect(body).toContain("{email}");
  });
});
