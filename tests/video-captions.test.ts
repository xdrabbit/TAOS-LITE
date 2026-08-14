// Fences for the /video caption pipeline's pure helpers: the SRT/VTT formats
// (comma-vs-dot millis silently break some players), translation batching
// (a miscounted batch desynchronizes every caption after it), and the
// whisper language-name → app code mapping.
import { describe, expect, it } from "vitest";
import {
  batchSegments,
  formatSrtTimestamp,
  formatVttTimestamp,
  toSrt,
  toVtt,
  whisperLanguageToCode,
  type CaptionSegment
} from "@/lib/video/captions";
import { buildCaptionTranslationInstructions } from "@/lib/translate/prompts";

describe("timestamp formatting", () => {
  it("SRT uses a comma before milliseconds, VTT a dot", () => {
    expect(formatSrtTimestamp(62.345)).toBe("00:01:02,345");
    expect(formatVttTimestamp(62.345)).toBe("00:01:02.345");
  });

  it("handles hours and zero", () => {
    expect(formatSrtTimestamp(3723.5)).toBe("01:02:03,500");
    expect(formatVttTimestamp(0)).toBe("00:00:00.000");
  });

  it("clamps negative and non-finite times to zero", () => {
    expect(formatSrtTimestamp(-3)).toBe("00:00:00,000");
    expect(formatVttTimestamp(Number.NaN)).toBe("00:00:00.000");
  });
});

const SEGMENTS: CaptionSegment[] = [
  { start: 0, end: 2.5, text: "Hello there.", translation: "Hola." },
  { start: 2.5, end: 5, text: "How are you?", translation: "¿Cómo estás?" }
];

describe("toSrt", () => {
  it("emits numbered cues with comma timestamps, translated track by default", () => {
    const srt = toSrt(SEGMENTS);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:02,500\nHola.");
    expect(srt).toContain("2\n00:00:02,500 --> 00:00:05,000\n¿Cómo estás?");
  });

  it("can emit the original track", () => {
    expect(toSrt(SEGMENTS, "original")).toContain("Hello there.");
  });

  it("falls back to the original text when a segment has no translation", () => {
    const srt = toSrt([{ start: 0, end: 1, text: "untranslated" }]);
    expect(srt).toContain("untranslated");
  });

  it("skips empty segments without breaking cue numbering", () => {
    const srt = toSrt([
      { start: 0, end: 1, text: "  " },
      { start: 1, end: 2, text: "kept" }
    ]);
    expect(srt.startsWith("1\n")).toBe(true);
    expect(srt).toContain("kept");
  });

  it("softens a literal --> inside cue text", () => {
    const srt = toSrt([{ start: 0, end: 1, text: "a --> b" }]);
    expect(srt).toContain("a -> b");
    // The only remaining --> is the cue timing arrow itself.
    expect(srt.match(/-->/g)).toHaveLength(1);
  });

  it("gives a zero-length cue a minimal visible window", () => {
    const srt = toSrt([{ start: 5, end: 5, text: "blip" }]);
    expect(srt).toContain("00:00:05,000 --> 00:00:05,500");
  });
});

describe("toVtt", () => {
  it("starts with the WEBVTT header and uses dot timestamps", () => {
    const vtt = toVtt(SEGMENTS);
    expect(vtt.startsWith("WEBVTT\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:02.500\nHola.");
  });
});

describe("batchSegments", () => {
  it("keeps offsets aligned to the full segment list", () => {
    const batches = batchSegments(["a", "b", "c", "d", "e"], 1000, 2);
    expect(batches.map((b) => b.offset)).toEqual([0, 2, 4]);
    expect(batches.map((b) => b.texts)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("splits on character budget", () => {
    const long = "x".repeat(90);
    const batches = batchSegments([long, long, long], 100, 60);
    expect(batches).toHaveLength(3);
  });

  it("accepts a single over-budget segment rather than looping", () => {
    const batches = batchSegments(["x".repeat(9999)], 100, 60);
    expect(batches).toHaveLength(1);
    expect(batches[0].texts).toHaveLength(1);
  });

  it("returns nothing for an empty transcript", () => {
    expect(batchSegments([])).toEqual([]);
  });
});

describe("whisperLanguageToCode", () => {
  it("maps whisper's language names to app codes", () => {
    expect(whisperLanguageToCode("english")).toBe("en");
    expect(whisperLanguageToCode("Spanish")).toBe("es");
    expect(whisperLanguageToCode("cantonese")).toBe("yue");
  });

  it("falls back to English for unknown or missing names", () => {
    expect(whisperLanguageToCode("klingon")).toBe("en");
    expect(whisperLanguageToCode(undefined)).toBe("en");
  });
});

describe("buildCaptionTranslationInstructions", () => {
  it("states the count-preservation contract and the JSON shape", () => {
    const prompt = buildCaptionTranslationInstructions("English", "Spanish");
    expect(prompt).toContain("EXACTLY the same number of");
    expect(prompt).toContain('{"lines"');
    expect(prompt).toContain("never merge");
  });

  it("keeps the translate-only and no-guess fences (7/27)", () => {
    const prompt = buildCaptionTranslationInstructions("English", "Spanish");
    expect(prompt).toContain("never answered");
    expect(prompt).toContain("NEVER fill a gap");
  });

  it("appends the colloquial rule when the output is Cantonese", () => {
    expect(buildCaptionTranslationInstructions("English", "Cantonese")).toContain("粵語口語");
    expect(buildCaptionTranslationInstructions("English", "Spanish")).not.toContain("粵語口語");
  });
});
