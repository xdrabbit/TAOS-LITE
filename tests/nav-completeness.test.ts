// The fence this change was actually for.
//
// /tabletop shipped, worked, was wired to the whole language catalog — and
// then spent RC1 with no way to reach it. Not because anyone deleted the
// link: the link was there, inside a `{founder ? …}` branch, and everyone
// who looked at the nav source saw a Table entry and moved on. Tom found it
// by walking the Droid and running out of places to tap.
//
// So this file does not check that a particular link exists. It enumerates
// the routes under app/ and insists every one of them is either REACHABLE
// (linked from a nav surface, with the release flags OFF) or GATED (behind a
// flag, and NOT linked when that flag is off). A new screen with no nav entry
// fails here on the day it is added, and a screen that quietly slips behind a
// conditional fails the same way.
//
// When this test fails, the question is "can a customer still get there?" —
// not "which literal moved?".
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Nav surfaces: everything a person can tap without typing a URL. */
const SURFACES = {
  /** The signed-in home screen — pill row, launcher grid, avatar menu. */
  app: "components/TranslatorShell.tsx",
  /** The logged-out storefront, which is what a QR code opens. */
  landing: "components/Landing.tsx",
  /** The share sheet: the QR itself, and whatever travels alongside it. */
  share: "components/QrShareModal.tsx"
} as const;

/**
 * Screens a customer must be able to reach, and the surface that must offer
 * them. `/translate` is the "Type & translate" screen; the spoken-turns
 * screen IS the app surface, so it has no link to itself.
 */
const REACHABLE: Record<string, Array<keyof typeof SURFACES>> = {
  live: ["app"],
  chat: ["app"],
  tabletop: ["app"],
  translate: ["app"],
  vision: ["app"],
  about: ["app", "landing"],
  guide: ["app", "landing"],
  try: ["landing"]
};

/**
 * Screens held back, and the guard that holds them. With these off — which is
 * what production ships — none of them may appear on a nav surface.
 * See lib/release.ts for why each one is dark.
 */
const GATED: Record<string, string> = {
  tutor: "tutorEnabled()",
  // /fast is founders-only on the same two-function shape as /call: a public
  // flag that has not shipped (NEXT_PUBLIC_ENABLE_FAST) plus a founder bypass.
  // Stripping this block is what a CUSTOMER's grid menu looks like.
  fast: "fastVisible",
  // /call went from "dark to everyone" back to founders-only on 8/27, so the
  // guard it hides behind is a founder check now, not the public flag. The
  // flag is still off and still real — callVisibleTo() is `flag || founder`,
  // so stripping this block is what a CUSTOMER's nav looks like.
  call: "callVisible",
  video: "founder"
};

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Source with commentary removed — the comments discuss the very routes
 *  being counted ("Call is off for RC1"), and a mention is not a link. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .map((line) => line.replace(/\s+\/\/(?!\/).*$/, ""))
    .join("\n");
}

/**
 * Delete every `{guard ? ( … )}` block, so what remains is the nav a customer
 * sees with the release flags off. Brace-counted rather than regexed: the
 * blocks nest, and one of the links carries a template literal with its own
 * braces.
 */
function withGuardsOff(source: string, guards: string[]): string {
  let out = source;
  for (const guard of guards) {
    const open = `{${guard} ? (`;
    for (;;) {
      const start = out.indexOf(open);
      if (start === -1) break;
      let depth = 0;
      let end = start;
      for (let i = start; i < out.length; i += 1) {
        if (out[i] === "{") depth += 1;
        else if (out[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      out = out.slice(0, start) + out.slice(end + 1);
    }
  }
  return out;
}

/**
 * The three tiers of the signed-in header, sliced apart.
 *
 * The nav restructure made "is it linked from the app surface?" too coarse a
 * question: the same screen is deliberately in two places now, and one of the
 * two tiers holds nothing but account items. What matters per screen is WHICH
 * tier it landed in — /vision spent months in a menu labelled "More" mixed in
 * among Sign out, which is how the guide came to tell readers that the photo
 * translator lives in "the account menu".
 *
 * Sliced by landmark rather than by brace-matching: the launcher menu opens
 * first in the source, the account menu second, and the pill row is <nav>.
 * `role="menuitem"` does not match `role="menu"` — the closing quote is what
 * keeps those apart.
 */
function tiers(guardsOff: boolean): { grid: string; avatar: string; pills: string } {
  let source = code(SURFACES.app);
  if (guardsOff) source = withGuardsOff(source, Object.values(GATED));
  const h = source.slice(source.indexOf("<header"), source.indexOf("</header>"));
  const first = h.indexOf('role="menu"');
  const second = h.indexOf('role="menu"', first + 1);
  const nav = h.indexOf("<nav");
  expect(first, "no launcher menu in the header").toBeGreaterThan(-1);
  expect(second, "no account menu in the header").toBeGreaterThan(first);
  expect(nav, "no pill row in the header").toBeGreaterThan(second);
  return {
    grid: h.slice(first, second),
    avatar: h.slice(second, nav),
    pills: h.slice(nav, h.indexOf("</nav>", nav))
  };
}

function hrefs(region: string): Set<string> {
  const found = new Set<string>();
  for (const m of region.matchAll(/href="\/([a-z-]*)"/g)) found.add(m[1]);
  return found;
}

/** Route segments under app/, minus the API surface. */
function appRoutes(): string[] {
  return readdirSync(new URL("../app", import.meta.url), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "api")
    .map((e) => e.name)
    .sort();
}

function links(surface: keyof typeof SURFACES, guardsOff: boolean): Set<string> {
  let source = code(SURFACES[surface]);
  if (guardsOff) source = withGuardsOff(source, Object.values(GATED));
  const found = new Set<string>();
  for (const m of source.matchAll(/href="\/([a-z-]*)"/g)) found.add(m[1]);
  return found;
}

describe("every screen is accounted for", () => {
  it("classifies every route under app/ as reachable or gated", () => {
    // The anti-orphan check. Add app/whatever and this fails until you say,
    // out loud and in this file, whether a customer can get to it.
    const classified = [...Object.keys(REACHABLE), ...Object.keys(GATED)].sort();
    expect(appRoutes()).toEqual(classified);
  });

  it("does not classify a screen as both reachable and gated", () => {
    for (const screen of Object.keys(GATED)) {
      expect(Object.keys(REACHABLE)).not.toContain(screen);
    }
  });
});

describe("reachable screens are actually linked, with the flags off", () => {
  for (const [screen, surfaces] of Object.entries(REACHABLE)) {
    for (const surface of surfaces) {
      it(`/${screen} is linked from ${SURFACES[surface]}`, () => {
        expect(links(surface, true)).toContain(screen);
      });
    }
  }

  it("keeps Table in the nav for everyone, not just founders", () => {
    // The actual regression: `href="/tabletop"` was present in the source the
    // whole time, inside `{founder ? …}`. Stripping the guards is what tells
    // the two cases apart, so this asserts the stripped form directly.
    expect(links("app", true)).toContain("tabletop");
  });

  it("offers Share from the app surface", () => {
    // Share is a button, not an href — it opens QrShareModal in place.
    expect(code(SURFACES.app)).toContain('aria-label="Share TAOS / Compartir TAOS"');
  });

  it("sends the quick start along with the QR code", () => {
    // Asserted by constant rather than by href, for the same reason Share is
    // asserted by aria-label: the sheet renders `href={guideHref}`, so there
    // is no literal path in this file to grep for. What matters is that the
    // sheet still carries the guide — handing someone the app and handing
    // them the instructions is meant to be one gesture.
    const sheet = code(SURFACES.share);
    expect(sheet).toContain("GUIDE_PATH");
    expect(sheet).toContain("GUIDE_TITLE");
  });
});

describe("gated screens stay off the nav", () => {
  for (const [screen, guard] of Object.entries(GATED)) {
    it(`/${screen} is not linked anywhere while ${guard} is off`, () => {
      for (const surface of Object.keys(SURFACES) as Array<keyof typeof SURFACES>) {
        expect(links(surface, true)).not.toContain(screen);
      }
    });

    it(`/${screen} returns to the nav when ${guard} is on`, () => {
      // The other half: a gated link must still EXIST behind its guard.
      // Deleting the link outright would pass the test above and quietly
      // make the flag do nothing.
      expect(links("app", false)).toContain(screen);
    });
  }
});

// ── The three tiers ────────────────────────────────────────────────────────
// Pills are the daily verbs. The launcher is the whole catalog. The avatar is
// identity. A screen may be in both of the first two — that redundancy is the
// point of the restructure and is asserted here rather than merely tolerated —
// but nothing about the ACCOUNT belongs in either of them, and no screen
// belongs in the avatar menu.
describe("the nav is three tiers, and each holds its own kind of thing", () => {
  /** Daily verbs. Ungated ones — Call is a founder's fifth pill, below. */
  const PILLS = ["translate", "live", "tabletop", "chat"];
  /** Every surface, gates aside. "" is the home screen, href="/". */
  const GRID = ["", "translate", "live", "tabletop", "chat", "vision"];
  /** Identity, and the two reading screens that go with it. */
  const AVATAR = ["guide", "about"];

  for (const screen of PILLS) {
    it(`/${screen} is one touch from the pill row`, () => {
      expect(hrefs(tiers(true).pills)).toContain(screen);
    });
  }

  for (const screen of GRID) {
    it(`/${screen} is in the launcher grid`, () => {
      // Including "" — the screen you are standing on. A launcher that omits
      // the current app has a hole in it exactly where a stranger looks first.
      expect(hrefs(tiers(true).grid)).toContain(screen);
    });
  }

  it("puts every daily verb in BOTH tiers, on purpose", () => {
    // Stated as its own case because the previous fence said the opposite —
    // "one entry per screen" — and someone reading only the diff would take
    // this for the duplication that rule was guarding against. It is not: the
    // pills answer "take me there" and the grid answers "what can this app
    // do?", and those are different questions from different people.
    const t = tiers(true);
    for (const screen of PILLS) {
      expect(hrefs(t.pills)).toContain(screen);
      expect(hrefs(t.grid)).toContain(screen);
    }
  });

  it("keeps the account menu free of screens, and the screens free of account items", () => {
    const t = tiers(true);
    for (const screen of AVATAR) expect(hrefs(t.avatar)).toContain(screen);
    // No screen in the avatar menu...
    for (const screen of [...GRID, ...Object.keys(GATED)]) {
      if (screen === "") continue;
      expect(hrefs(t.avatar)).not.toContain(screen);
    }
    // ...and no account item in either nav tier.
    for (const account of AVATAR) {
      expect(hrefs(t.pills)).not.toContain(account);
      expect(hrefs(t.grid)).not.toContain(account);
    }
    // Sign out and History are buttons, not hrefs — assert them by label.
    expect(t.avatar).toContain("Sign out · Salir");
    expect(t.avatar).toContain("History · Historial");
    expect(t.pills).not.toContain("Sign out");
    expect(t.grid).not.toContain("Sign out");
  });

  it("shows a stranger no gated screen in any tier", () => {
    const t = tiers(true);
    for (const screen of Object.keys(GATED)) {
      expect(hrefs(t.grid)).not.toContain(screen);
      expect(hrefs(t.pills)).not.toContain(screen);
      expect(hrefs(t.avatar)).not.toContain(screen);
    }
  });

  it("brings every gated screen back into the launcher when its guard is on", () => {
    // The other half: a gated entry must still EXIST behind its guard, or the
    // flag does nothing. Call additionally returns as a pill — Tom and Liz use
    // it daily and it was two touches deep until 8/31.
    const t = tiers(false);
    for (const screen of Object.keys(GATED)) {
      expect(hrefs(t.grid)).toContain(screen);
    }
    expect(hrefs(t.pills)).toContain("call");
  });

  it("has no disclosure left anywhere in the pill row", () => {
    // "Together ▾" held /chat and /tabletop behind a touch. Both are pills now,
    // and this is the assertion that stops a fourth screen quietly collapsing
    // back into a menu the next time the row feels crowded — which is exactly
    // how Together ▾ was born on 8/19.
    const pills = tiers(true).pills;
    expect(pills).not.toContain("▾");
    expect(pills).not.toContain('role="menu"');
    expect(pills).not.toContain("aria-haspopup");
  });
});
