// Fences the language-pill rule on /translate (8/17, the Bosnia + Italy trip).
// The pair is [yours, theirs]; "theirs" is the output the pills show selected.
import { describe, expect, it } from "vitest";
import { nextPair } from "@/lib/translate/pair";

describe("language pills: tapping a language picks the OUTPUT", () => {
  it("tapping a new language makes it the output and keeps your side", () => {
    // Tom (English) walks into a shop in Mostar and taps BS.
    expect(nextPair(["en", "es"], "bs")).toEqual(["en", "bs"]);
    // ...and in Italy the next week.
    expect(nextPair(["en", "bs"], "it")).toEqual(["en", "it"]);
  });

  it("tapping the language that is already the output changes nothing", () => {
    const pair = ["en", "es"] as const;
    // The SAME reference, so the caller can tell a no-op tap from a real one
    // and leave the translation currently on screen alone.
    expect(nextPair(pair, "es")).toBe(pair);
  });

  it("tapping your own side flips the pair", () => {
    // This is Liz's path to ES⇄IT from the same four pills: tap ES (her side
    // becomes the output), then tap IT.
    expect(nextPair(["en", "it"], "en")).toEqual(["it", "en"]);
    expect(nextPair(["it", "en"], "es")).toEqual(["it", "es"]);
  });

  it("never produces a pair of the same language twice", () => {
    // Auto-detect is scoped to the pair's two languages — a doubled side would
    // ask the model to choose between a language and itself.
    const codes = ["en", "es", "bs", "it", "zh", "yue"] as const;
    for (const a of codes) {
      for (const b of codes) {
        if (a === b) continue;
        for (const tapped of codes) {
          const [x, y] = nextPair([a, b], tapped);
          expect(x).not.toBe(y);
        }
      }
    }
  });

  it("keeps the ES⇄EN happy path reachable in one tap from anywhere", () => {
    // Tom and Liz's daily pair is never more than a tap or two away no matter
    // where the trip left the picker.
    expect(nextPair(["en", "it"], "es")).toEqual(["en", "es"]);
    expect(nextPair(["es", "bs"], "en")).toEqual(["es", "en"]);
  });
});
