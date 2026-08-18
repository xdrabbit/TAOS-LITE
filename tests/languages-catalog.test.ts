// The catalog is now the only list of languages in the app, which makes it the
// only place a language can go wrong. These pin the three things every other
// screen trusts it for: that the tier flags match what the providers actually
// do, that the picker's order and search put a language within reach, and that
// the languages TAOS already shipped never quietly fall out of it.
import { describe, expect, it } from "vitest";
import {
  canSpeak,
  getLanguage,
  isLanguageCode,
  LANGUAGES,
  languageLabel,
  searchLanguages,
  SHEET_LANGUAGES,
  SPEAKABLE_LANGUAGES
} from "@/lib/languages/catalog";

describe("the catalog's shape", () => {
  it("holds Whisper's whole language list, once each", () => {
    // 100 is Whisper's LANGUAGES table (tokenizer.py). The catalog IS that
    // table — anything Whisper can hear, TAOS can at least read back.
    expect(LANGUAGES).toHaveLength(100);
    expect(new Set(LANGUAGES.map((l) => l.code)).size).toBe(100);
  });

  it("gives every language all four names and a flag", () => {
    // A blank English label would reach the translation prompt as
    // "The speaker talks in ." — a silent quality bug, not a crash.
    for (const language of LANGUAGES) {
      expect(language.label.trim()).not.toBe("");
      expect(language.labelEs.trim()).not.toBe("");
      expect(language.native.trim()).not.toBe("");
      expect(language.flag.trim()).not.toBe("");
      expect(language.stt).toBe(true);
    }
  });
});

describe("tier 1 vs tier 2", () => {
  it("speaks exactly what ElevenLabs says it speaks", () => {
    // eleven_turbo_v2_5 / eleven_flash_v2_5, GET /v1/models on 2026-08-17.
    // ElevenLabs' "fil" is the catalog's "tl". If ELEVENLABS_MODEL ever moves,
    // re-run that call and update this list WITH the catalog.
    const elevenLabsTurbo = [
      "ar", "bg", "cs", "da", "de", "el", "en", "es", "fi", "fr", "hi", "hr", "hu", "id",
      "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "ta", "tl",
      "tr", "uk", "vi", "zh"
    ];
    for (const code of elevenLabsTurbo) {
      expect(canSpeak(code), `${code} should be tier 1`).toBe(true);
    }
    // The two that reach speech another way, both already in production:
    // Bosnian rides Croatian pronunciation, Cantonese routes to eleven_v3.
    expect(canSpeak("bs")).toBe(true);
    expect(getLanguage("bs")?.ttsVoiceHint).toBe("hr");
    expect(canSpeak("yue")).toBe(true);

    expect(SPEAKABLE_LANGUAGES).toHaveLength(elevenLabsTurbo.length + 2);
  });

  it("marks a language ElevenLabs cannot speak as text-only", () => {
    // THE tier-2 contract: canSpeak is false, so TranslatorShell never calls
    // /api/tts for it and /api/tts refuses if something else tries. Thai and
    // Hebrew are Whisper-fluent and absent from every ElevenLabs model.
    for (const code of ["th", "he", "fa", "bn", "sr", "ca", "eu"]) {
      expect(canSpeak(code), `${code} should be tier 2`).toBe(false);
      expect(isLanguageCode(code)).toBe(true); // still selectable, still translated
    }
  });

  it("treats an unknown code as unspeakable rather than guessing", () => {
    expect(canSpeak("xx")).toBe(false);
    expect(canSpeak("")).toBe(false);
    expect(isLanguageCode("xx")).toBe(false);
  });
});

describe("the languages TAOS already shipped", () => {
  it("still carries every language the old pill row could select", () => {
    // en/es are the household; bs/it were the trip (8/17); zh/yue were the
    // guests (7/25). Losing one of these from the catalog would strand a
    // saved pair in localStorage on a phone that is mid-conversation.
    for (const code of ["en", "es", "bs", "it", "zh", "yue"]) {
      expect(isLanguageCode(code)).toBe(true);
      expect(canSpeak(code)).toBe(true);
    }
  });

  it("keeps the English labels the prompts were written against", () => {
    expect(languageLabel("bs")).toBe("Bosnian");
    expect(languageLabel("it")).toBe("Italian");
    // buildInstructions/buildAutoDetectInstructions switch on this exact
    // string to attach the colloquial-Cantonese rule (lib/translate/prompts).
    expect(languageLabel("yue")).toBe("Cantonese");
  });
});

describe("the picker's order", () => {
  it("leads with the world's most useful languages", () => {
    expect(SHEET_LANGUAGES.slice(0, 6).map((l) => l.code)).toEqual([
      "en", "es", "zh", "hi", "ar", "pt"
    ]);
  });

  it("puts the unranked rest in English alphabetical order", () => {
    const rest = SHEET_LANGUAGES.filter((l) => !l.rank);
    const sorted = [...rest].sort((a, b) => a.label.localeCompare(b.label, "en"));
    expect(rest.map((l) => l.label)).toEqual(sorted.map((l) => l.label));
    // …and the ranked twenty all come first.
    expect(SHEET_LANGUAGES.slice(0, 20).every((l) => l.rank)).toBe(true);
  });

  it("shows everything when nothing has been typed", () => {
    expect(searchLanguages("")).toEqual(SHEET_LANGUAGES);
    expect(searchLanguages("   ")).toEqual(SHEET_LANGUAGES);
  });
});

describe("searching for a language", () => {
  it("finds it by English, Spanish, or its own name", () => {
    const codes = (q: string) => searchLanguages(q).map((l) => l.code);
    expect(codes("German")).toContain("de");
    expect(codes("Alemán")).toContain("de");
    expect(codes("Deutsch")).toContain("de");
    expect(codes("中文")).toContain("zh");
  });

  it("does not ask anyone to type an accent", () => {
    // Liz looking for French on an English keyboard, and the reverse.
    expect(searchLanguages("frances").map((l) => l.code)).toContain("fr");
    expect(searchLanguages("espanol").map((l) => l.code)).toContain("es");
    expect(searchLanguages("FRANCES").map((l) => l.code)).toContain("fr");
  });

  it("ranks the exact code first, then prefixes, then the rest", () => {
    // "it" is Italian's code but also sits inside "British"-ish words and
    // several native names — the code has to win or Italian is unreachable
    // by the two letters printed on its own pill.
    expect(searchLanguages("it")[0].code).toBe("it");
    // A prefix beats a substring: "por" is Portuguese before it is anything
    // that merely contains those letters.
    expect(searchLanguages("por")[0].code).toBe("pt");
  });

  it("finds a tier-2 language as readily as a tier-1 one", () => {
    // Two taps to ANY language is the promise; text-only ones are not hidden.
    expect(searchLanguages("Thai")[0].code).toBe("th");
    expect(searchLanguages("Tailandés")[0].code).toBe("th");
  });

  it("comes back empty rather than guessing at nonsense", () => {
    expect(searchLanguages("zzzzq")).toHaveLength(0);
  });
});
