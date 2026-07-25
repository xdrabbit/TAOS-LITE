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
    expect(p).toContain(`"lang":"en"|"zh"`);
  });

  it("keeps the casual faithfulness fence in auto mode too", () => {
    const p = buildAutoDetectInstructions(
      { code: "en", label: "English" },
      { code: "es", label: "Spanish" },
      "casual"
    );
    expect(p).toContain("never invent or substitute content");
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
