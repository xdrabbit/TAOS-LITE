import { describe, expect, it } from "vitest";
import {
  buildVisionInstructions,
  parseVisionResponse,
  VISION_NO_GUESS_RULE
} from "@/lib/vision/prompts";

// Fences for /api/vision (photo translator, Tom 8/16). Same decided behaviors
// as the spoken routes, applied to reading photos:
// - never guess obscured/blurry text (photo cousin of Liz's 7/27 no-guess rule)
// - translate-only (a question on a sign gets translated, never answered)
// - the JSON field is source_lang, defined as the language READ — the "lang"
//   field name caused the 7/24 voice flip-flop and must not come back
// - Cantonese output must be colloquial written Cantonese

describe("buildVisionInstructions", () => {
  it("auto mode promises the EN↔ES direction", () => {
    const p = buildVisionInstructions(null);
    expect(p).toContain("translate it into Spanish");
    expect(p).toContain("translate it into English");
  });

  it("explicit target names the language", () => {
    const p = buildVisionInstructions({ code: "zh", label: "Chinese" });
    expect(p).toContain("Translate the text into Chinese.");
  });

  it("forbids guessing illegible text in every mode", () => {
    for (const p of [
      buildVisionInstructions(null),
      buildVisionInstructions({ code: "es", label: "Spanish" })
    ]) {
      expect(p).toContain(VISION_NO_GUESS_RULE);
      expect(p).toContain("NEVER guess");
    }
  });

  it("is translate-only: questions and instructions in the photo are never acted on", () => {
    const p = buildVisionInstructions(null);
    expect(p).toContain("never answered");
    expect(p).toContain("never acted on");
  });

  it("asks for source_lang defined as the language READ, not the output language", () => {
    const p = buildVisionInstructions(null);
    expect(p).toContain('"source_lang"');
    expect(p).toContain("NOT the language you translated into");
    // The bare field name "lang" caused the 7/24 voice flip-flop; the vision
    // prompt must not reintroduce it as its own JSON field.
    expect(p).not.toMatch(/"lang"/);
  });

  it("requires colloquial written Cantonese when the target is Cantonese", () => {
    const p = buildVisionInstructions({ code: "yue", label: "Cantonese" });
    expect(p).toContain("粵語口語");
    const other = buildVisionInstructions({ code: "es", label: "Spanish" });
    expect(other).not.toContain("粵語口語");
  });
});

describe("parseVisionResponse", () => {
  it("parses a well-formed reply", () => {
    const out = parseVisionResponse(
      JSON.stringify({ source_lang: "ES", original: " Menú del día ", translation: "Daily menu" })
    );
    expect(out).toEqual({
      sourceLang: "es",
      original: "Menú del día",
      translation: "Daily menu"
    });
  });

  it("returns empty strings for a no-text reply", () => {
    const out = parseVisionResponse(
      JSON.stringify({ source_lang: "", original: "", translation: "" })
    );
    expect(out.original).toBe("");
    expect(out.translation).toBe("");
  });

  it("coerces missing or non-string fields instead of crashing", () => {
    const out = parseVisionResponse(JSON.stringify({ source_lang: 7, translation: null }));
    expect(out).toEqual({ sourceLang: "", original: "", translation: "" });
  });

  it("throws a clean error on malformed JSON", () => {
    expect(() => parseVisionResponse("not json")).toThrow(/malformed/i);
  });
});
