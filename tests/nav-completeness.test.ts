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
  /** The signed-in home screen — header pills, Together menu, account menu. */
  app: "components/TranslatorShell.tsx",
  /** The logged-out storefront, which is what a QR code opens. */
  landing: "components/Landing.tsx"
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
  try: ["landing"]
};

/**
 * Screens held back, and the guard that holds them. With these off — which is
 * what production ships — none of them may appear on a nav surface.
 * See lib/release.ts for why each one is dark.
 */
const GATED: Record<string, string> = {
  tutor: "tutorEnabled()",
  call: "callEnabled()",
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
