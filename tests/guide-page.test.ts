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
import { copyFor, ENGLISH, fill, type ChromeKey } from "@/lib/chrome/copy";

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
    // Short quoted UI labels are exempt: a label the app prints in only one
    // language has to be quoted the same on both sides, and pretending
    // otherwise would send a reader looking for chrome that does not exist.
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
  // The five chrome labels below say lib/chrome/copy.ts rather than a shell.
  // They did not change a character — the TABLE moved out of the two shells
  // that each kept one, so /tabletop and /call could share it. The assertion
  // is still exact-string and still two-sided; only the file it reads moved.
  const QUOTED: Array<[string, string]> = [
    ["Continue with Google", "components/SignIn.tsx"],
    ["Add to Home Screen", "components/InstallPrompt.tsx"],
    ["START LISTENING", "components/LiveShell.tsx"],
    ["TAP TO TALK", "lib/chrome/copy.ts"],
    ["TAP WHEN DONE", "lib/chrome/copy.ts"],
    // "Together ▾" was here until the nav restructure removed it. The guide
    // pointed readers at a disclosure that no longer exists; the fence caught
    // it, which is the fence working. The header labels it was replaced by
    // ("Table · Mesa", "All screens · Pantallas", "Photo translator · Fotos")
    // are one language per phone now, so they are checked per language in
    // the case below this loop rather than as doubled literals.
    ["+ More · Más", "components/LanguagePicker.tsx"],
    ["Text only · Solo texto", "components/TextOnly.tsx"],
    // "Translate into · Traducir a" was here until 2026-10-04, when home's
    // picker caption went one language per phone like the header did. It is
    // checked per language in the home-label case below, same as the nav.
    ["Tap the mic, speak a full thought, tap again.", "lib/chrome/copy.ts"],
    ["Lay the phone flat between you", "lib/chrome/copy.ts"],
    ["Pon el teléfono entre ustedes", "lib/chrome/copy.ts"]
  ];

  for (const [label, source] of QUOTED) {
    it(`"${label}" is still in ${source}`, () => {
      expect(guide).toContain(label);
      expect(read(source)).toContain(label);
    });
  }

  it("names each header control by the word on THAT reader's phone", () => {
    // The header reads in the phone owner's language (lib/chrome/copy.ts), so
    // an English paragraph must quote the English label and a Spanish one the
    // Spanish label — "Toca Table arriba" sends a Spanish reader looking for a
    // word her phone does not show. Exact strings, both sides, both languages.
    const inLang = (lang: "en" | "es") =>
      GUIDE_SECTIONS.flatMap((s) => [
        s.intro?.[lang] ?? "",
        s.footnote?.[lang] ?? "",
        ...s.entries.flatMap((e) => [e.body[lang], e.example?.[lang] ?? ""])
      ]).join("\n");
    const en = inLang("en");
    const es = inLang("es");
    const shell = read("components/TranslatorShell.tsx");
    const QUOTED_NAV: ChromeKey[] = ["navTranslate", "navLive", "navTable", "navAllScreens", "navPhoto"];
    for (const key of QUOTED_NAV) {
      expect(shell, `${key} is not on the header`).toContain(`nav.${key}`);
      expect(en, `English guide does not quote ${ENGLISH[key]}`).toContain(ENGLISH[key]);
      expect(es, `Spanish guide does not quote ${copyFor("es")[key]}`).toContain(copyFor("es")[key]);
    }
  });

  it("quotes home's picker caption, trial banner and Upgrade button by the word on THAT reader's phone", () => {
    // Same rule as the header above, for the home-screen words the languages
    // and free sections quote. These went one language per phone on
    // 2026-10-04 (the banner and button had been English-only), so the
    // English half must quote the English word and the Spanish half the
    // Spanish one — and the shell must still be printing that key.
    const inLang = (lang: "en" | "es") =>
      GUIDE_SECTIONS.flatMap((s) => [
        s.intro?.[lang] ?? "",
        ...s.entries.flatMap((e) => [e.body[lang], e.example?.[lang] ?? ""])
      ]).join("\n");
    const en = inLang("en");
    const es = inLang("es");
    const shell = read("components/TranslatorShell.tsx");
    const QUOTED_HOME: ChromeKey[] = ["translateInto", "upgrade"];
    for (const key of QUOTED_HOME) {
      expect(shell, `${key} is not on home`).toContain(`s.${key}`);
      expect(en, `English guide does not quote ${ENGLISH[key]}`).toContain(ENGLISH[key]);
      expect(es, `Spanish guide does not quote ${copyFor("es")[key]}`).toContain(copyFor("es")[key]);
    }
    expect(shell).toContain("fill(s.trialLeft, { count: transLeft })");
    expect(en).toContain(fill(ENGLISH.trialLeft, { count: FREE_TRANSLATIONS }));
    expect(es).toContain(fill(copyFor("es").trialLeft, { count: FREE_TRANSLATIONS }));
    // …and neither half still quotes the doubled caption that is gone.
    expect(en + es).not.toContain("Translate into · Traducir a");
  });

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
