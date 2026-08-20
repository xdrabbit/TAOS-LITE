// The /translate pills are only as good as the server's allow-list: an output
// language missing from it makes /api/translate answer "Unsupported language
// pair." (400) and the turn dies on the phone. That allow-list is no longer a
// hand-kept 13 — it is lib/languages/catalog.ts, so what this file fences is
// the DERIVATION: that the server still speaks the same {code,label} shape the
// routes and <select>s were written against, and that its answers still come
// from the catalog rather than a second list drifting alongside it.
import { describe, expect, it } from "vitest";
import {
  getLanguageLabel,
  isSourceLanguageCode,
  isSupportedLanguageCode,
  LANGUAGE_OPTIONS
} from "@/lib/realtime/languages";
import { LANGUAGES, SHEET_LANGUAGES } from "@/lib/languages/catalog";

describe("supported languages behind the /translate pills", () => {
  it("accepts every language the pill row can select", () => {
    for (const code of ["en", "es", "bs", "it", "zh", "yue"]) {
      expect(isSupportedLanguageCode(code)).toBe(true);
    }
  });

  it("labels are the ones the prompts name to the model", () => {
    // buildInstructions / buildAutoDetectInstructions interpolate these into
    // the system prompt ("The speaker talks in Bosnian"), so a blank or
    // code-shaped label would quietly degrade the translation.
    expect(getLanguageLabel("bs")).toBe("Bosnian");
    expect(getLanguageLabel("it")).toBe("Italian");
  });

  it("accepts Bosnian's neighbours — the gates are open now", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the reversal is the point of
    // the 8/17 change rather than an accident: the allow-list was the only
    // thing keeping the phone away from languages the pipeline could already
    // translate. Croatian and Serbian are the nearest example — a sign in
    // Mostar could be any of the three — but the rule is general: if Whisper
    // can hear it, /api/translate now accepts it. Whether it also comes back
    // as audio is the catalog's tier flag, asked at synthesis, not here.
    expect(isSupportedLanguageCode("hr")).toBe(true);
    expect(isSupportedLanguageCode("sr")).toBe(true);
    // Tier 2 languages pass validation too — they are translated, just not
    // spoken. A 400 here would be the old bug wearing a new hat.
    expect(isSupportedLanguageCode("th")).toBe(true);
    expect(isSupportedLanguageCode("he")).toBe(true);
  });

  it("still rejects what is not a language", () => {
    // Open gates, not no gate: the route needs a real code to put a real
    // language NAME in the prompt, and "" or "xx" would name nothing.
    expect(isSupportedLanguageCode("xx")).toBe(false);
    expect(isSupportedLanguageCode("")).toBe(false);
    expect(isSupportedLanguageCode("english")).toBe(false);
    // "auto" is a source-only value — a target of "auto" has no meaning.
    expect(isSupportedLanguageCode("auto")).toBe(false);
    expect(isSourceLanguageCode("auto")).toBe(true);
  });
});

describe("the server list derives from the catalog", () => {
  it("offers every catalog language, in the picker's order", () => {
    // One list, not two. If these ever diverge, some screen is rendering a
    // language another screen's route will reject.
    expect(LANGUAGE_OPTIONS).toHaveLength(LANGUAGES.length);
    expect(LANGUAGE_OPTIONS.map((o) => o.code)).toEqual(SHEET_LANGUAGES.map((l) => l.code));
    expect(LANGUAGE_OPTIONS[0].code).toBe("en");
  });

  it("carries an English label for each, since <option>s render it raw", () => {
    for (const option of LANGUAGE_OPTIONS) {
      expect(option.label.trim()).not.toBe("");
      expect(getLanguageLabel(option.code)).toBe(option.label);
    }
  });
});
