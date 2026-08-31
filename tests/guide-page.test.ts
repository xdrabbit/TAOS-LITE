import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FREE_TRANSLATIONS,
  GUIDE_DESCRIPTION,
  GUIDE_LANGS,
  GUIDE_PATH,
  GUIDE_SECTIONS,
  GUIDE_TITLE,
  LANGUAGE_COUNT
} from "@/lib/guide";
import { QUOTAS } from "@/lib/supabase";

// /guide is the quick start handed to a group of travellers by QR code. Three
// things about it are worth fencing, and they are the three things that rot:
//
//   1. It is bilingual EVERYWHERE. Half the people it is handed to read the
//      Spanish first, and a section that quietly ships English-only is a
//      section they cannot use.
//   2. It names controls that EXIST. A guide is trusted, so a stale label is
//      worse than no label — the reader hunts for a button that was renamed
//      and concludes the app is broken. The labels quoted below are pulled
//      out of the components they belong to and compared.
//   3. It is REACHABLE, from the two surfaces the feature was asked for: the
//      storefront footer and the QR share sheet. (tests/nav-completeness.test.ts
//      holds the same fence from the nav's side.)
//
// Plus the /about rule, which applies to every public page: no personal names.

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Same list as tests/about-page.test.ts — a NEW signature is the failure. */
const PERSONAL_NAMES = [/lizmariett/i, /marquez/i, /\bliz\b/i, /\btom\b/i];

/** Every string the page can render, flattened. */
function allCopy(): string[] {
  const out: string[] = [GUIDE_TITLE, GUIDE_DESCRIPTION];
  for (const s of GUIDE_SECTIONS) {
    out.push(s.heading.en, s.heading.es);
    if (s.intro) out.push(s.intro.en, s.intro.es);
    if (s.footnote) out.push(s.footnote.en, s.footnote.es);
    for (const e of s.entries) {
      out.push(e.label, e.body.en, e.body.es);
      if (e.example) out.push(e.example.en, e.example.es);
    }
  }
  return out;
}

describe("no personal names on /guide", () => {
  it("keeps them out of every string the page renders", () => {
    for (const value of allCopy()) {
      for (const name of PERSONAL_NAMES) expect(value).not.toMatch(name);
    }
  });

  it("keeps them out of the source too, comments included", () => {
    // Source-read on purpose: copy inlined into the JSX would skip the check
    // above entirely, and a comment naming whose trip this was written for is
    // the same leak by a slower route.
    for (const path of ["lib/guide.ts", "app/guide/page.tsx"]) {
      for (const name of PERSONAL_NAMES) expect(read(path)).not.toMatch(name);
    }
  });
});

describe("the page renders both languages", () => {
  it("ships English and Spanish, in that order", () => {
    expect([...GUIDE_LANGS]).toEqual(["en", "es"]);
  });

  it("gives every section both halves", () => {
    for (const s of GUIDE_SECTIONS) {
      expect(s.heading.en.trim()).not.toBe("");
      expect(s.heading.es.trim()).not.toBe("");
      if (s.intro) {
        expect(s.intro.en.trim()).not.toBe("");
        expect(s.intro.es.trim()).not.toBe("");
      }
      if (s.footnote) {
        expect(s.footnote.en.trim()).not.toBe("");
        expect(s.footnote.es.trim()).not.toBe("");
      }
    }
  });

  it("gives every entry both halves", () => {
    for (const s of GUIDE_SECTIONS) {
      expect(s.entries.length).toBeGreaterThan(0);
      for (const e of s.entries) {
        expect(e.label.trim()).not.toBe("");
        expect(e.body.en.trim()).not.toBe("");
        expect(e.body.es.trim()).not.toBe("");
        if (e.example) {
          expect(e.example.en.trim()).not.toBe("");
          expect(e.example.es.trim()).not.toBe("");
        }
      }
    }
  });

  it("never leaves the two halves identical", () => {
    // The realistic failure is a Spanish field filled in with the English
    // sentence to get a build green, which reads as translated and is not.
    // Short quoted UI labels are exempt: "Free · 25 translations left this
    // month" is the same string on both sides BECAUSE the app prints it in
    // English, and pretending otherwise would send a reader looking for
    // Spanish chrome that does not exist.
    for (const s of GUIDE_SECTIONS) {
      expect(s.heading.en).not.toBe(s.heading.es);
      if (s.intro) expect(s.intro.en).not.toBe(s.intro.es);
      if (s.footnote) expect(s.footnote.en).not.toBe(s.footnote.es);
      for (const e of s.entries) expect(e.body.en).not.toBe(e.body.es);
    }
  });

  it("renders every section through the same bilingual markup", () => {
    // Both halves must be marked for screen readers and for the browser's own
    // translation prompt, which is the difference between a bilingual page
    // and a page with Spanish in it.
    const page = read("app/guide/page.tsx");
    expect(page).toContain('lang="en"');
    expect(page).toContain('lang="es"');
    expect(page).toContain("GUIDE_SECTIONS.map");
  });
});

describe("it covers what a first-time reader needs", () => {
  it("carries the five sections, in order", () => {
    expect(GUIDE_SECTIONS.map((s) => s.id)).toEqual([
      "install",
      "modes",
      "photo",
      "languages",
      "free"
    ]);
  });

  it("walks through install in three steps", () => {
    const install = GUIDE_SECTIONS.find((s) => s.id === "install");
    expect(install?.entries).toHaveLength(3);
  });

  it("describes all four ways to talk", () => {
    const modes = GUIDE_SECTIONS.find((s) => s.id === "modes");
    expect(modes?.entries).toHaveLength(4);
  });
});

describe("the labels it quotes are the labels on the screen", () => {
  const guide = allCopy().join("\n");

  // Each pair is [what /guide tells the reader to look for, where that string
  // has to exist]. When one of these fails, the label moved — fix the guide,
  // do not loosen the test.
  const QUOTED: Array<[string, string]> = [
    ["Continue with Google", "components/SignIn.tsx"],
    ["Add to Home Screen", "components/InstallPrompt.tsx"],
    ["START LISTENING", "components/LiveShell.tsx"],
    ["TAP TO TALK", "components/TabletopShell.tsx"],
    ["TAP WHEN DONE", "components/TabletopShell.tsx"],
    ["Table · Mesa", "components/TranslatorShell.tsx"],
    ["Chat · Chat", "components/TranslatorShell.tsx"],
    ["Together ▾", "components/TranslatorShell.tsx"],
    ["Photo translator · Fotos", "components/TranslatorShell.tsx"],
    ["+ More · Más", "components/LanguagePicker.tsx"],
    ["Text only · Solo texto", "components/TextOnly.tsx"],
    ["Translate into · Traducir a", "components/TranslatorShell.tsx"],
    ["Tap the mic, speak a full thought, tap again.", "components/TranslatorShell.tsx"],
    ["Lay the phone flat between you", "components/TabletopShell.tsx"],
    ["Pon el teléfono entre ustedes", "components/TabletopShell.tsx"]
  ];

  for (const [label, source] of QUOTED) {
    it(`"${label}" is still in ${source}`, () => {
      expect(guide).toContain(label);
      expect(read(source)).toContain(label);
    });
  }

  it("does not call the microphone screen 'Translate'", () => {
    // The trap this guide had to walk around: the header pill labelled
    // Translate is the TYPING screen (app/translate), and the microphone
    // screen is the one the app opens on and has no pill at all. A guide that
    // conflates them sends every reader to the wrong screen on step one.
    const modes = GUIDE_SECTIONS.find((s) => s.id === "modes");
    const spoken = modes?.entries[0];
    expect(spoken?.label).toBe("Speak · Hablar");
    expect(spoken?.body.en).toMatch(/opens on/i);
    // …and the typing pill is still accounted for, by its real name.
    expect(modes?.footnote?.en).toMatch(/Translate pill/);
  });
});

describe("the numbers it quotes are the app's numbers", () => {
  it("quotes the free allowance the app actually enforces", () => {
    expect(FREE_TRANSLATIONS).toBe(QUOTAS.free.translations);
  });

  it("prints the allowance rather than a hand-typed number", () => {
    const free = GUIDE_SECTIONS.find((s) => s.id === "free");
    const text = free?.entries.map((e) => `${e.body.en} ${e.example?.en ?? ""}`).join(" ") ?? "";
    expect(text).toContain(String(FREE_TRANSLATIONS));
  });

  it("derives the language count from the catalog", () => {
    // Same fence as /about: a hand-typed "100 languages" is wrong the day the
    // catalog changes, and nobody re-reads a guide looking for it.
    expect(LANGUAGE_COUNT).toBeGreaterThan(0);
    expect(read("lib/guide.ts")).not.toMatch(/\b100 (languages|idiomas)\b/);
  });
});

describe("a reader can get to it", () => {
  it("lives at /guide", () => {
    expect(GUIDE_PATH).toBe("/guide");
  });

  it("is linked from the storefront footer", () => {
    const landing = read("components/Landing.tsx");
    expect(landing).toContain('href="/guide"');
    // In the footer specifically — a link in the hero would not survive the
    // next redesign of the hero.
    expect(landing.slice(landing.indexOf("<footer"))).toContain('href="/guide"');
  });

  it("is linked from the share sheet, by the name the feature was asked for", () => {
    expect(GUIDE_TITLE).toBe("How to use TAOS · Cómo usar TAOS");
    expect(read("components/QrShareModal.tsx")).toContain("GUIDE_TITLE");
  });

  it("is linked from the signed-in app", () => {
    expect(read("components/TranslatorShell.tsx")).toContain('href="/guide"');
  });

  it("is not gated behind a session", () => {
    // Step one of the page is "sign in". Gating it would be a door that asks
    // you to read the sign on the other side of it.
    //
    // Matched on the IMPORT, not the word: the page's own header comment says
    // why it is ungated, and a test that forbids naming SessionGate forbids
    // explaining the decision.
    expect(read("app/guide/page.tsx")).not.toMatch(/from "@\/components\/SessionGate"/);
  });
});
