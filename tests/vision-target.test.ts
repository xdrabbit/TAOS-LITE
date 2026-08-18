// Fences what language a photo comes back in (8/17, the Bosnia + Italy trip).
// The photo translator has no picker of its own by default: it reads the pair
// /translate saved and translates into YOUR side of it.
import { describe, expect, it } from "vitest";
import { nextPair, parseStoredPair, type PairLangCode } from "@/lib/translate/pair";
import { PHOTO_TARGET_AUTO, photoTargetLanguage } from "@/lib/vision/target";

describe("photo target = your side of the pair", () => {
  it("gives Tom English for a Bosnian menu", () => {
    // Tom's phone after tapping BS on the pills: [yours=en, theirs=bs].
    expect(photoTargetLanguage(["en", "bs"])).toBe("en");
  });

  it("gives Liz Spanish for the same menu", () => {
    expect(photoTargetLanguage(["es", "bs"])).toBe("es");
  });

  it("follows the pills into Italy without another tap", () => {
    expect(photoTargetLanguage(["en", "it"])).toBe("en");
    expect(photoTargetLanguage(["es", "it"])).toBe("es");
  });

  it("is never the selected pill — that is the language you speak INTO", () => {
    // The bug this rule exists to prevent: a Bosnian menu translated into
    // Bosnian because the pill row shows BS selected.
    for (const pair of [
      ["en", "bs"],
      ["es", "it"],
      ["en", "yue"]
    ] as const) {
      expect(photoTargetLanguage(pair)).not.toBe(pair[1]);
    }
  });

  it("falls back to the route's auto rule when no pair was ever saved", () => {
    // A phone that opened /vision before it ever opened /translate. "auto" is
    // English → Spanish, anything else → English, which still reads a Bosnian
    // menu into English.
    expect(photoTargetLanguage(null)).toBe(PHOTO_TARGET_AUTO);
    expect(photoTargetLanguage(undefined)).toBe(PHOTO_TARGET_AUTO);
    expect(photoTargetLanguage(parseStoredPair("corrupt storage"))).toBe(PHOTO_TARGET_AUTO);
  });

  it("follows a flip, because a flip is what changes which side is yours", () => {
    // Tapping your own side swaps the pair (lib/translate/pair.ts), so the
    // photo target swaps with it — the two controls can never disagree about
    // which side is "yours". The "Read it in" override on /vision is the
    // escape hatch for a phone left flipped by the last person holding it.
    const flipped = nextPair(["en", "it"] as const, "en"); // -> ["it", "en"]
    expect(photoTargetLanguage(flipped)).toBe("it");
    // Picking a new language for the other side leaves your side alone.
    expect(photoTargetLanguage(nextPair(flipped, "es"))).toBe("it");
  });

  it("resolves to a language the pair can actually hold", () => {
    const codes: readonly PairLangCode[] = ["en", "es", "bs", "it", "zh", "yue"];
    for (const mine of codes) {
      for (const theirs of codes) {
        if (mine === theirs) continue;
        expect(photoTargetLanguage([mine, theirs])).toBe(mine);
      }
    }
  });
});
