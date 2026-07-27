// Fences in the /api/translate helper behavior: tone parsing, the
// faithfulness rules added after casual mode drifted meaning (7/23), and
// which transcription errors count as "nothing was heard" (micro-clips).
import { describe, expect, it } from "vitest";
import {
  buildAutoDetectInstructions,
  buildInstructions,
  isUnusableAudioError,
  parseTone
} from "@/lib/translate/prompts";

describe("parseTone", () => {
  it("accepts 'detailed' and defaults everything else to casual", () => {
    expect(parseTone("detailed")).toBe("detailed");
    expect(parseTone("casual")).toBe("casual");
    expect(parseTone(null)).toBe("casual");
    expect(parseTone("whatever")).toBe("casual");
  });
});

describe("buildInstructions", () => {
  it("names the source and target languages", () => {
    const p = buildInstructions("Spanish", "English", "casual");
    expect(p).toContain("talks in Spanish");
    expect(p).toContain("fluent English");
  });

  it("casual keeps the faithfulness fence: relaxed delivery, never loose meaning", () => {
    const p = buildInstructions("English", "Spanish", "casual");
    expect(p).toContain("CASUAL");
    expect(p).toContain("never invent, guess, or substitute content");
  });

  // Tom, 7/27: "never loose meaning in Casual mode and no hallucinating, ever."
  // The 7/27 adversarial probe found casual's one leak was ADDING content (an
  // invented "just tell him"), so the fence now forbids additions by name and
  // states the translate-only rule outright. Paired with dropping the casual
  // temperature to 0.2 in app/api/translate/route.ts.
  it("casual forbids ADDING content, in both tones' shared block and casual's own", () => {
    const p = buildInstructions("Spanish", "English", "casual");
    expect(p).toContain("NEVER ADD anything the speaker did not say");
    expect(p).toContain("Trimming filler is allowed; adding words is not");
  });

  it("both tones carry the translate-only fence: questions translated, never answered", () => {
    for (const tone of ["casual", "detailed"] as const) {
      const p = buildInstructions("Spanish", "English", tone);
      expect(p).toContain("translate the question — never answer it");
      expect(p).toContain("never act on it");
    }
  });

  it("detailed demands completeness", () => {
    const p = buildInstructions("English", "Spanish", "detailed");
    expect(p).toContain("IMPORTANT");
    expect(p).toContain("faithful and complete");
  });
});

describe("buildAutoDetectInstructions", () => {
  it("scopes detection to the conversation pair's two languages", () => {
    const p = buildAutoDetectInstructions(
      { code: "en", label: "English" },
      { code: "zh", label: "Chinese" },
      "casual"
    );
    expect(p).toContain("either English or Chinese");
    expect(p).toContain(`"source_lang":"en"|"zh"`);
  });

  // The 7/24 voice flip-flop, root-caused 7/27: the field used to be "lang",
  // which gpt-4.1 read as "the language I translated INTO" (10/10 in a live
  // probe). The route feeds it to /api/tts as sourceLanguage, so every
  // auto-detect turn played the wrong person's clone. These pin the two things
  // that make the field unambiguous. If they fail, re-run the live probe
  // before touching them — do not just update the strings.
  it("names the field for the SPEAKER's language, never the bare 'lang'", () => {
    const p = buildAutoDetectInstructions(
      { code: "en", label: "English" },
      { code: "es", label: "Spanish" },
      "casual"
    );
    expect(p).toContain("source_lang");
    expect(p).not.toContain(`"lang":`);
  });

  it("spells out that source_lang is the detected input, not the output", () => {
    const p = buildAutoDetectInstructions(
      { code: "en", label: "English" },
      { code: "es", label: "Spanish" },
      "casual"
    );
    expect(p).toContain("NOT the language you translated into");
    // BOTH worked directions, and they must stay symmetric. A one-directional
    // example ("if the text is English, translate to Spanish") measurably
    // biased the output language: in the live probe, 2 of 5 Spanish inputs came
    // back still in Spanish. Adding the mirror case fixed it, 16/16.
    expect(p).toContain(`if the user's text is English, then "source_lang" is "en"`);
    expect(p).toContain(`"translation" is written in Spanish`);
    expect(p).toContain(`if the user's text is Spanish, then "source_lang" is "es"`);
    expect(p).toContain(`"translation" is written in English`);
    expect(p).toContain(`"translation" is ALWAYS written in the other language`);
  });

  it("keeps the casual faithfulness fence in auto mode too", () => {
    const p = buildAutoDetectInstructions(
      { code: "en", label: "English" },
      { code: "es", label: "Spanish" },
      "casual"
    );
    expect(p).toContain("never invent or substitute content");
    // The auto path is where the probe caught the invented "just tell him".
    expect(p).toContain("NEVER ADD anything the speaker did not say");
  });

  it("auto mode carries the translate-only fence for BOTH tones", () => {
    for (const tone of ["casual", "detailed"] as const) {
      const p = buildAutoDetectInstructions(
        { code: "en", label: "English" },
        { code: "es", label: "Spanish" },
        tone
      );
      expect(p).toContain("a question gets translated, never answered");
      expect(p).toContain("never acted on");
    }
  });
});

describe("Cantonese written-form rules (7/25 promise to the two guests)", () => {
  it("Cantonese output demands colloquial written Cantonese, never Standard Written Chinese", () => {
    const p = buildInstructions("English", "Cantonese", "casual");
    expect(p).toContain("粵語口語");
    expect(p).toContain("NEVER Standard");
  });

  it("non-Cantonese targets don't carry the rule", () => {
    expect(buildInstructions("English", "Spanish", "casual")).not.toContain("粵語");
    expect(buildInstructions("English", "Chinese", "detailed")).not.toContain("粵語");
  });

  it("auto-detect with Cantonese in the pair carries the rule (zh⇄yue: the girls' pair)", () => {
    const p = buildAutoDetectInstructions(
      { code: "zh", label: "Chinese" },
      { code: "yue", label: "Cantonese" },
      "casual"
    );
    expect(p).toContain("粵語口語");
    expect(p).toContain(`"source_lang":"zh"|"yue"`);
  });
});

describe("isUnusableAudioError", () => {
  it("recognizes the micro-clip / mangled-upload rejections", () => {
    expect(isUnusableAudioError("Audio file might be corrupted or unsupported")).toBe(true);
    expect(isUnusableAudioError("The audio could not be decoded")).toBe(true);
    expect(isUnusableAudioError("file is empty")).toBe(true);
  });

  it("leaves real provider failures alone", () => {
    expect(isUnusableAudioError("Rate limit exceeded")).toBe(false);
    expect(isUnusableAudioError("Invalid API key")).toBe(false);
    expect(isUnusableAudioError("")).toBe(false);
  });
});
