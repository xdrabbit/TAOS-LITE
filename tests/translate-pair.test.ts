// Fences the language-pill rule on /translate (8/17, the Bosnia + Italy trip).
// The pair is [yours, theirs]; "theirs" is the output the pills show selected.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAIR,
  isPairLangCode,
  nextPair,
  parseStoredPair,
  otherInPair,
  pairDirection
} from "@/lib/translate/pair";

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

  it("does NOT flip your own side when the caller has locked it", () => {
    // Tom, mid-call on 9/3: the outlined pill said "You hear this", he tapped
    // it wanting that language, and the flip gave him the other one — plus an
    // announcement to his partner's phone and a write to localStorage. On a
    // call the pair is half of a handshake, so /call passes flipOnOwnSide
    // false and the tap becomes exactly what tapping the selected pill is.
    const pair = ["en", "es"] as const;
    expect(nextPair(pair, "en", { flipOnOwnSide: false })).toEqual(["en", "es"]);
    // The SAME reference, which is what makes it free: useLanguagePair's
    // identity check returns before setPair, writeStoredPair, or onPairChange.
    expect(nextPair(pair, "en", { flipOnOwnSide: false })).toBe(pair);
  });

  it("still picks a THIRD language when your own side is locked", () => {
    // The lock is about your own side, not about the row. Mid-call, changing
    // what your PARTNER speaks is the one thing this row is for.
    expect(nextPair(["en", "es"], "it", { flipOnOwnSide: false })).toEqual(["en", "it"]);
    // ...and the already-selected pill is still a no-op, as ever.
    const pair = ["en", "es"] as const;
    expect(nextPair(pair, "es", { flipOnOwnSide: false })).toBe(pair);
  });

  it("flips by default, so no other screen changed", () => {
    // /translate, /live and /tabletop pass nothing. The table rule is the
    // default precisely so that locking is something a caller opts INTO.
    expect(nextPair(["en", "it"], "en")).toEqual(["it", "en"]);
    expect(nextPair(["en", "it"], "en", {})).toEqual(["it", "en"]);
    expect(nextPair(["en", "it"], "en", { flipOnOwnSide: true })).toEqual(["it", "en"]);
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

describe("the saved pair: what survives on a phone", () => {
  // /translate writes it, /vision reads it — a pair that parses loosely would
  // send someone's menu translation to the wrong language.
  it("reads back a pair /translate wrote", () => {
    expect(parseStoredPair(JSON.stringify(["en", "bs"]))).toEqual(["en", "bs"]);
  });

  it("treats missing, corrupt, or unsupported storage as nothing saved", () => {
    expect(parseStoredPair(null)).toBeNull();
    expect(parseStoredPair("")).toBeNull();
    expect(parseStoredPair("not json")).toBeNull();
    expect(parseStoredPair(JSON.stringify(["en"]))).toBeNull();
    expect(parseStoredPair(JSON.stringify(["en", "es", "bs"]))).toBeNull();
    expect(parseStoredPair(JSON.stringify({ mine: "en", theirs: "es" }))).toBeNull();
    // Not a language at all (a typo, an old build's code) — fall back to the
    // defaults rather than asking a route to translate into "xx". The example
    // here used to be "sw": Swahili was unsupported when this test was
    // written and is a real catalog language since 8/17, which is the whole
    // point of the change — so the fence moved to a code that can never be
    // one, not away from the behavior.
    expect(parseStoredPair(JSON.stringify(["en", "xx"]))).toBeNull();
    expect(parseStoredPair(JSON.stringify(["en", "english"]))).toBeNull();
    // …and a language that only became reachable in 8/17 now survives, the
    // same as the six that were there before it.
    expect(parseStoredPair(JSON.stringify(["en", "sw"]))).toEqual(["en", "sw"]);
    // Doubled sides can't happen through nextPair, but hand-edited storage
    // must not get past this either.
    expect(parseStoredPair(JSON.stringify(["it", "it"]))).toBeNull();
  });

  it("keeps the guest languages behind Other readable too", () => {
    expect(parseStoredPair(JSON.stringify(["es", "yue"]))).toEqual(["es", "yue"]);
    expect(DEFAULT_PAIR).toEqual(["es", "en"]);
    for (const [a, b] of [DEFAULT_PAIR]) {
      expect(isPairLangCode(a)).toBe(true);
      expect(isPairLangCode(b)).toBe(true);
    }
  });
});

// ── Which way a turn runs ──────────────────────────────────────────────────
// The streaming screens feed these two straight into their request bodies —
// /live into /api/live-translate and /api/tts, /tabletop into the realtime
// session's per-turn instructions. Getting them backwards does not throw; it
// translates someone's own words back at them, in their own language, which
// looks like the model failing rather than the wiring.
describe("pairDirection", () => {
  it("sends a turn to the OTHER side, whoever is talking", () => {
    const pair = ["en", "it"] as const;
    expect(pairDirection(pair, "mine")).toEqual({ sourceLanguage: "en", targetLanguage: "it" });
    expect(pairDirection(pair, "theirs")).toEqual({ sourceLanguage: "it", targetLanguage: "en" });
  });

  it("is the identity of /live: they speak, I read my own language", () => {
    // /live is the screen where the persisted pair pays off. A phone left on
    // [en, it] after ordering dinner follows that same table with no taps —
    // Italian in, English out.
    expect(pairDirection(["en", "it"], "theirs")).toEqual({
      sourceLanguage: "it",
      targetLanguage: "en"
    });
  });

  it("never returns a language to itself", () => {
    for (const pair of [["en", "es"], ["bs", "it"], ["ja", "th"]] as const) {
      for (const side of ["mine", "theirs"] as const) {
        const d = pairDirection(pair, side);
        expect(d.sourceLanguage).not.toBe(d.targetLanguage);
      }
    }
  });
});

describe("otherInPair", () => {
  it("answers the side a speaker is being translated for", () => {
    expect(otherInPair(["en", "es"], "en")).toBe("es");
    expect(otherInPair(["en", "es"], "es")).toBe("en");
    // /tabletop: whoever tapped is the source, the far end is the target.
    expect(otherInPair(["es", "bs"], "bs")).toBe("es");
  });

  it("keeps an outsider's turn inside the conversation", () => {
    // A code that is not at the table at all (a stale exchange from before a
    // pill tap) answers with the pair's own second side rather than echoing
    // the outsider's language back at them.
    expect(otherInPair(["en", "it"], "ja")).toBe("en");
  });
});
