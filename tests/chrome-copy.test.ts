// The fence around the fallback, which is the only reason the catalog can be
// a hundred languages wide while the chrome is written in two.
//
// TAOS translates into ~100 languages and its own buttons are written in
// six-ish. Those two numbers are allowed to be different — that was the trade
// made when the catalog landed — but ONLY because a language with no chrome
// entry gets English buttons and a faithful translation, rather than a blank
// screen, a crash, or a hold-out from the language list.
//
// The trigger for writing this down: a woman who wants her grandfather to use
// TAOS in Samoan. Nobody here reads Samoan. `sm` has no entry and will not
// have one for a while, and it has to WORK anyway. That is what the first
// describe block below is about, and it is why the fallback is per-KEY: the
// day somebody writes six Samoan words, those six must land without the other
// hundred-odd going blank.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHROME_LANGUAGES,
  ENGLISH,
  copyFor,
  fill,
  splitAround,
  type ChromeKey
} from "@/lib/chrome/copy";

const KEYS = Object.keys(ENGLISH) as ChromeKey[];

describe("a language nobody has translated still works", () => {
  it("gives Samoan the whole English table rather than nothing", () => {
    // Not a hypothetical. `sm` is in the catalog and reaches every screen.
    const sm = copyFor("sm");
    for (const key of KEYS) {
      expect(sm[key]).toBe(ENGLISH[key]);
    }
  });

  it("never returns a blank or an undefined, for any key, in any language", () => {
    // The failure this replaces is a button with no words on it, which is
    // worse than a button in the wrong language: you cannot even guess.
    for (const code of [...CHROME_LANGUAGES, "sm", "th", "ar", "zz", ""]) {
      const copy = copyFor(code);
      for (const key of KEYS) {
        expect(typeof copy[key], `${code}.${key}`).toBe("string");
        expect(copy[key].trim(), `${code}.${key}`).not.toBe("");
      }
    }
  });

  it("does not throw on a code that is not a language at all", () => {
    expect(() => copyFor("not-a-language")).not.toThrow();
    expect(copyFor("not-a-language").speak).toBe(ENGLISH.speak);
  });
});

describe("the fallback is per key, not per language", () => {
  it("keeps a partial language's own words AND fills its gaps from English", () => {
    // Bosnian has the home screen and nothing else — nobody here can check a
    // Bosnian /call. Both halves of that sentence are asserted here, because
    // a merge that got either one wrong would still look fine on one screen.
    const bs = copyFor("bs");
    expect(bs.speak).toBe("Govori"); // its own
    expect(bs.speak).not.toBe(ENGLISH.speak);
    expect(bs.callJoin).toBe(ENGLISH.callJoin); // English, by design
    expect(bs.callHangUp).toBe(ENGLISH.callHangUp);
    expect(bs.interpreterOffHint).toBe(ENGLISH.interpreterOffHint);
  });

  it("gives Spanish its own words on every screen, /call included", () => {
    // The one language written for this PR, and the reason for it: Liz reads
    // Spanish, owns most of this company, and would not use /call.
    const es = copyFor("es");
    expect(es.speak).toBe("Hablar");
    expect(es.tapToTalk).toBe("TOCA PARA HABLAR");
    for (const key of KEYS) {
      expect(es[key], key).not.toBe(ENGLISH[key]);
    }
  });

  it("leaves the four unchecked languages absent on /call, not guessed", () => {
    // If one of these ever stops equalling English it means somebody invented
    // a translation in a language nobody at this table can check. Write it
    // with a speaker in the room, then move this line.
    for (const code of ["bs", "it", "zh", "yue"]) {
      const copy = copyFor(code);
      expect(copy.callJoin, code).toBe(ENGLISH.callJoin);
      expect(copy.callCaptionsOn, code).toBe(ENGLISH.callCaptionsOn);
      expect(copy.interpreterFailedLabel, code).toBe(ENGLISH.interpreterFailedLabel);
    }
  });
});

describe("adding a language is adding an entry", () => {
  it("has no key in a translation that English does not declare", () => {
    // A typo'd key is silent: it sits in the table, matches nothing, and the
    // screen shows English forever while the file looks translated.
    for (const code of CHROME_LANGUAGES) {
      for (const key of Object.keys(copyFor(code))) {
        expect(KEYS, `${code}.${key}`).toContain(key);
      }
    }
  });

  it("returns the same object for the same language twice", () => {
    // Merged once, on a screen that re-renders on every caption.
    expect(copyFor("es")).toBe(copyFor("es"));
  });

  it("hands out a frozen table, because every screen gets the same object", () => {
    // One screen patching a label in place would rewrite it for every other
    // screen for the rest of the session.
    const copy = copyFor("it") as Record<string, string>;
    expect(() => {
      copy.speak = "patched";
    }).toThrow();
    expect(copyFor("it").speak).toBe("Parla");
  });
});

describe("nobody keeps a second copy of the table", () => {
  // Source-reading, like tests/screen-language-wiring.test.ts, and for the
  // same reason: three private tables is how /tabletop ended up with a
  // cut-down twin of the home screen's and /call with none at all. A screen
  // that grows its own `const STRINGS` or `const L` again fails here rather
  // than on a trip.
  const SHELLS = ["components/TranslatorShell.tsx", "components/TabletopShell.tsx"];

  it("every shell reads the shared module", () => {
    for (const path of SHELLS) {
      const src = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      expect(src, path).toContain('from "@/lib/chrome/copy"');
    }
  });

  it("no shell declares a chrome table of its own", () => {
    for (const path of SHELLS) {
      const src = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join("\n");
      expect(src, path).not.toMatch(/const (STRINGS|L)\s*[:=]/);
      expect(src, path).not.toMatch(/function copyFor\b/);
    }
  });
});

describe("a value in a sentence is a slot, not a seam", () => {
  it("interpolates the countdown the /call idle notice carries", () => {
    expect(fill(ENGLISH.callIdleNotice, { seconds: 12 })).toContain("about 12s");
    expect(fill(copyFor("es").callIdleNotice, { seconds: 12 })).toContain("unos 12s");
  });

  it("keeps the slot INSIDE the translated sentence, in both languages", () => {
    // This is the whole reason it is a template and not a concatenation: a
    // language is free to put the number, or the language name, anywhere in
    // the sentence — including first.
    for (const code of ["en", "es"]) {
      expect(copyFor(code).callIdleNotice).toContain("{seconds}");
      expect(copyFor(code).callYouHear).toContain("{language}");
      expect(copyFor(code).callSameLanguage).toContain("{language}");
      expect(copyFor(code).callMidCallPair).toContain("{language}");
      expect(copyFor(code).callInterpreterError).toContain("{reason}");
    }
  });

  it("leaves an unknown slot visible rather than printing undefined", () => {
    expect(fill("hola {segundos}", { seconds: 3 })).toBe("hola {segundos}");
  });

  it("splits a sentence at its slot so JSX can style the value", () => {
    const [before, after] = splitAround("You hear {language}. Their phone announces.", "language");
    expect(before).toBe("You hear ");
    expect(after).toBe(". Their phone announces.");
  });

  it("degrades to the whole sentence when the slot is missing", () => {
    // A translator who drops the token gets a sentence with no value in it,
    // which is wrong but readable — not a half-sentence.
    const [before, after] = splitAround("Escuchas tu idioma.", "language");
    expect(before).toBe("Escuchas tu idioma.");
    expect(after).toBe("");
  });
});
