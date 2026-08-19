import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ABOUT_COPY,
  ABOUT_DESCRIPTION,
  ABOUT_EN,
  ABOUT_ES,
  ABOUT_TITLE,
  LANGUAGE_COUNT,
  SUPPORT_EMAIL
} from "@/lib/about";
import { LANGUAGES } from "@/lib/languages/catalog";

// /about is the page a stranger reaches from the QR code, and until 8/19 it was
// a signed personal dedication ("Made for Lizmariett Marquez", "— Tom"). Tom's
// call that day: the public page reads as a product; the dedication moves to
// docs/backstory.md verbatim, held for a future "Our story" page.
//
// Both halves of that decision are fenced here — the names must not come back
// onto the page, AND the dedication must not disappear from the repo. Undoing
// either is a product decision: get Tom's say-so and change this test in the
// same PR.

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// Deliberately broader than the two names that were actually on the page: the
// failure worth catching is a NEW signature, not a revert of the old one.
const PERSONAL_NAMES = [/lizmariett/i, /marquez/i, /\bliz\b/i, /\btom\b/i];

describe("no personal names on /about", () => {
  it("keeps them out of every string the page renders", () => {
    const strings = [
      ABOUT_TITLE,
      ABOUT_DESCRIPTION,
      ...ABOUT_COPY.flatMap((c) => [c.heading, c.body, c.contactLabel, c.contactHint])
    ];
    for (const value of strings) {
      for (const name of PERSONAL_NAMES) expect(value).not.toMatch(name);
    }
  });

  it("keeps them out of the page source too, comments included", () => {
    // Source-read on purpose: copy inlined straight into the JSX would skip
    // the check above entirely, and that is the easy way for a name to return.
    const page = read("app/about/page.tsx");
    for (const name of PERSONAL_NAMES) expect(page).not.toMatch(name);
  });

  it("carries no signature or dedication line", () => {
    const rendered = [ABOUT_TITLE, ABOUT_DESCRIPTION, ...ABOUT_COPY.map((c) => c.body)].join(" ");
    expect(rendered).not.toMatch(/—\s*\w+\s*$/);
    expect(rendered).not.toMatch(/made for|dedicat|con todo el cariño/i);
  });
});

describe("the page renders both languages", () => {
  it("ships exactly English and Spanish, in that order", () => {
    expect(ABOUT_COPY.map((c) => c.lang)).toEqual(["en", "es"]);
    expect(ABOUT_COPY).toEqual([ABOUT_EN, ABOUT_ES]);
  });

  it("gives each half real, distinct prose — not a placeholder or a copy", () => {
    for (const copy of ABOUT_COPY) {
      expect(copy.heading.trim().length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(120);
      expect(copy.contactLabel.trim().length).toBeGreaterThan(0);
    }
    expect(ABOUT_EN.body).not.toBe(ABOUT_ES.body);
    expect(ABOUT_EN.heading).not.toBe(ABOUT_ES.heading);
  });

  it("actually says what TAOS does, on both sides", () => {
    expect(ABOUT_EN.body).toMatch(/spoken/i);
    expect(ABOUT_EN.body).toMatch(/photo/i);
    expect(ABOUT_ES.body).toMatch(/hablada/i);
    expect(ABOUT_ES.body).toMatch(/foto/i);
  });

  it("titles the page bilingually, per the app's 'English · Español' convention", () => {
    expect(ABOUT_TITLE).toContain("·");
    expect(ABOUT_TITLE).toContain("About TAOS");
    expect(ABOUT_TITLE).toContain("Acerca de TAOS");
  });

  it("renders both halves from the catalog rather than one hardcoded block", () => {
    const page = read("app/about/page.tsx");
    expect(page).toContain("ABOUT_COPY.map");
    // lang="…" per half, so a screen reader switches voice at the divider.
    expect(page).toContain("lang={copy.lang}");
  });
});

describe("contact details", () => {
  it("uses the support mailbox and links it as mail", () => {
    expect(SUPPORT_EMAIL).toBe("support@taoslite.com");
    const page = read("app/about/page.tsx");
    expect(page).toContain("mailto:${SUPPORT_EMAIL}");
  });

  it("offers support in both languages", () => {
    expect(ABOUT_EN.contactLabel).toBe("Support");
    expect(ABOUT_ES.contactLabel).toBe("Soporte");
  });
});

describe("the version line", () => {
  it("reuses the footer's marker rather than printing its own", () => {
    const page = read("app/about/page.tsx");
    expect(page).toContain('from "@/lib/version"');
    expect(page).toContain("{BUILD_LABEL}");
    // One definition, two screens — /translate's footer reads the same const.
    expect(read("components/TranslatorShell.tsx")).toContain('from "@/lib/version"');
    expect(read("lib/version.ts")).toContain("process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA");
  });
});

describe("the language count", () => {
  it("is derived from the catalog, never typed into the copy by hand", () => {
    expect(LANGUAGE_COUNT).toBe(LANGUAGES.length);
    expect(ABOUT_EN.body).toContain(String(LANGUAGE_COUNT));
    expect(ABOUT_ES.body).toContain(String(LANGUAGE_COUNT));
    expect(read("lib/about.ts")).not.toMatch(/\b100 (languages|idiomas)\b/);
  });
});

describe("the dedication survives in the repo", () => {
  it("is preserved verbatim in docs/backstory.md", () => {
    // The point of the 8/19 change was to move it off the public page, NOT to
    // lose it. If this file goes, the original prose is gone with it.
    const backstory = read("docs/backstory.md");
    expect(backstory).toContain("Made for Lizmariett Marquez");
    expect(backstory).toContain("TAOS was built for one person");
    expect(backstory).toContain("TAOS nació para una persona");
    expect(backstory).toContain("Para Liz y su familia en Venezuela");
    expect(backstory).toContain("— Tom");
  });

  it("is marked as held for a future page, not as dead text", () => {
    expect(read("docs/backstory.md")).toMatch(/our story/i);
  });
});
