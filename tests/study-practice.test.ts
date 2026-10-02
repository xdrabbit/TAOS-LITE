// Fences for how a pronunciation score is read back to the learner
// (lib/study/practice.ts). The numbers come from Azure; what is pinned is the
// interpretation the viewer prototype arrived at — which words to show, which
// sub-score to blame, and the silence threshold that keeps Azure from being
// paid to score nothing.
import { describe, expect, it } from "vitest";
import {
  SILENCE_PEAK,
  band,
  bestOf,
  costHint,
  isMissed,
  lowestOf,
  overallOf,
  visibleWords,
  type ScoredWord
} from "@/lib/study/practice";

const w = (word: string, accuracy: number | null, errorType: string | null = "None"): ScoredWord => ({
  word,
  accuracy,
  errorType
});

describe("band", () => {
  it("is green at 80, amber at 60, red below, and nothing for no number", () => {
    expect(band(80)).toBe("good");
    expect(band(79.9)).toBe("ok");
    expect(band(60)).toBe("ok");
    expect(band(59.9)).toBe("poor");
    expect(band(null)).toBeNull();
    expect(band(undefined)).toBeNull();
  });
});

describe("overallOf", () => {
  it("prefers Microsoft's weighted overall, falls back to accuracy, and rounds", () => {
    expect(overallOf({ pron: 87.4, accuracy: 20 })).toBe(87);
    expect(overallOf({ pron: null, accuracy: 72.6 })).toBe(73);
    expect(overallOf({})).toBeNull();
  });
});

describe("visibleWords / isMissed", () => {
  it("hides insertions and keeps omissions, marked", () => {
    const words = [w("voy", 90), w("um", null, "Insertion"), w("camino", null, "Omission")];
    const shown = visibleWords(words);
    expect(shown.map((x) => x.word)).toEqual(["voy", "camino"]);
    expect(isMissed(shown[1])).toBe(true);
    expect(isMissed(shown[0])).toBe(false);
  });

  it("is empty, not undefined, for a missing list", () => {
    expect(visibleWords(undefined)).toEqual([]);
  });
});

describe("lowestOf / costHint", () => {
  it("names the sub-score that pulled the overall down", () => {
    expect(lowestOf({ accuracy: 90, fluency: 40, completeness: 95 })).toBe("flow");
    expect(lowestOf({ accuracy: 90, fluency: 85, completeness: 50 })).toBe("completeness");
    expect(lowestOf({ accuracy: 55, fluency: 85, completeness: 95 })).toBe("pronunciation");
  });

  it("says Nice at 80 and above, in the lesson's language", () => {
    expect(costHint({ pron: 80, accuracy: 80, fluency: 80, completeness: 80 }, "en")).toBe("Nice.");
    expect(costHint({ pron: 80, accuracy: 80, fluency: 80, completeness: 80 }, "es")).toBe("Bien.");
  });

  it("blames flow when flow is what cost it, even if every word is green", () => {
    // The case the prototype learned from: all-green words under a 61 looked
    // like a bug until the hint named the flow.
    const r = { pron: 61, accuracy: 92, fluency: 38, completeness: 100 };
    expect(costHint(r, "en")).toMatch(/^Flow is what cost you/);
    expect(costHint(r, "es")).toMatch(/fluidez/);
  });

  it("points at the crossed-out words when completeness is the problem", () => {
    const r = { pron: 55, accuracy: 90, fluency: 90, completeness: 40 };
    expect(costHint(r, "en")).toMatch(/crossed-out/);
    expect(costHint(r, "es")).toMatch(/tachadas/);
  });

  it("falls back to English for a language with no hint text", () => {
    expect(costHint({ pron: 95 }, "it")).toBe("Nice.");
  });
});

describe("bestOf", () => {
  it("is the rounded maximum, ignoring nulls, and null before any score", () => {
    expect(bestOf([61, 87.6, null, undefined, 72])).toBe(88);
    expect(bestOf([null, undefined])).toBeNull();
    expect(bestOf([])).toBeNull();
  });
});

describe("the silence threshold", () => {
  it("is one percent of full scale", () => {
    // Below this the loudest sample is noise. Raising it would start refusing
    // quiet-but-real attempts; lowering it would let a muted mic reach Azure.
    expect(SILENCE_PEAK).toBe(0.01);
  });
});
