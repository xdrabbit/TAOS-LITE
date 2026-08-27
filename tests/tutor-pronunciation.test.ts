// Crawl's third tier: which languages a repetition can actually be SCORED in.
//
// The app already has two tiers and they mean different things — Whisper can
// hear 100 languages, ElevenLabs can speak 34 (lib/languages/catalog.ts). Azure
// pronunciation assessment covers 24 of them, and the failure mode this file
// exists for is the quiet one: sending Spanish audio to an English acoustic
// model and rendering the confident 31 it hands back as the learner's score.
import { describe, expect, it } from "vitest";
import {
  ASSESSABLE_LANGUAGES,
  assessmentLocale,
  canAssessPronunciation,
  resolveAssessmentLocale
} from "@/lib/tutor/pronunciation";
import { isLanguageCode, LANGUAGES } from "@/lib/languages/catalog";

describe("the assessable languages", () => {
  it("are all real catalog languages", () => {
    for (const code of ASSESSABLE_LANGUAGES) {
      expect(isLanguageCode(code), code).toBe(true);
    }
  });

  it("are a subset of what the app can hear, and smaller than what it can speak", () => {
    expect(ASSESSABLE_LANGUAGES.length).toBeLessThan(LANGUAGES.filter((l) => l.tts).length);
  });

  it("map to the locale Azure knows them by", () => {
    expect(assessmentLocale("en")).toBe("en-US");
    expect(assessmentLocale("hi")).toBe("hi-IN");
    expect(assessmentLocale("zh")).toBe("zh-CN");
    expect(assessmentLocale("yue")).toBe("zh-HK");
  });

  it("scores Spanish as Latin American, which is the Spanish in this house", () => {
    // Liz is Venezuelan. Scoring Tom's Spanish against Castilian would mark
    // him down for the vowels he is actually trying to learn. Written down
    // rather than left to look inevitable — see lib/tutor/pronunciation.ts.
    expect(assessmentLocale("es")).toBe("es-MX");
  });

  it("says no for a language Azure cannot assess", () => {
    expect(canAssessPronunciation("bs")).toBe(false); // tier 1 for speech, unscorable
    expect(canAssessPronunciation("fa")).toBe(false);
    expect(assessmentLocale("sw")).toBeNull();
  });
});

describe("resolving what the client asked for", () => {
  it("takes a catalog code, as the module lessons send", () => {
    expect(resolveAssessmentLocale("es")).toBe("es-MX");
  });

  it("takes a full locale, as the legacy 30-day drills send", () => {
    expect(resolveAssessmentLocale("en-US")).toBe("en-US");
  });

  it("never falls back to English", () => {
    // The dangerous default. An unrecognized language must produce "we can't
    // score this", not a score computed against the wrong language.
    expect(resolveAssessmentLocale("sw")).toBeNull();
    expect(resolveAssessmentLocale("")).toBeNull();
    expect(resolveAssessmentLocale(undefined)).toBeNull();
    expect(resolveAssessmentLocale("nonsense")).toBeNull();
  });
});
