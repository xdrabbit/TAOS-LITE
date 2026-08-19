// What POST /api/text-translate is told, and what it decides from it.
//
// The typing surface is the last screen that was still EN⇄ES (8/19), and half
// of the reason was on this side of the network: the route took an
// `"en-es" | "es-en"` string and translated between two hard-coded codes. The
// screen could have grown a hundred pills and still sent everything to
// Spanish.
//
// resolveTextLanguages is the rule, lifted out of the handler so it can be
// tested without a server — the same reason nextPair and buildInstructions
// live outside their routes.
import { describe, expect, it } from "vitest";
import {
  FALLBACK_PAIR,
  otherSide,
  resolveTextLanguages,
  SAME_LANGUAGE
} from "@/lib/translate/textRequest";

describe("the pair a text translation runs between", () => {
  it("takes the two languages it is given", () => {
    // The case Tom's walkthrough was missing: EN → BS, from the pills.
    expect(resolveTextLanguages({ sourceLanguage: "en", targetLanguage: "bs" })).toEqual({
      pair: ["en", "bs"],
      source: "en"
    });
  });

  it("runs the other way round when the other side is typing", () => {
    // The You/Them toggle does not send a different KEY, it sends the pair
    // the other way round — which is all pairDirection() does on the screen.
    expect(resolveTextLanguages({ sourceLanguage: "bs", targetLanguage: "en" })).toEqual({
      pair: ["bs", "en"],
      source: "bs"
    });
  });

  it("carries a tier-2 language like any other", () => {
    // Bengali is translated but never spoken (lib/languages/catalog.ts). That
    // is a fact about SYNTHESIS and has nothing to say about text: this route
    // returns words, so a tier-2 target is an ordinary request.
    expect(resolveTextLanguages({ sourceLanguage: "en", targetLanguage: "bn" })).toEqual({
      pair: ["en", "bn"],
      source: "en"
    });
  });

  it("auto-detects between the two sides it was handed, not between en and es", () => {
    // The old auto prompt asked "English or Spanish?" for every request. With
    // a pair it asks about the pair, and `source: null` is what tells the
    // handler to go and ask.
    expect(
      resolveTextLanguages({ sourceLanguage: "it", targetLanguage: "bs", direction: "auto" })
    ).toEqual({ pair: ["it", "bs"], source: null });
  });

  it("refuses a pair of one repeated language", () => {
    // nextPair cannot produce one (lib/translate/pair.ts): two identical sides
    // ask the model to choose between a language and itself. A request that
    // says so is a caller bug, and gets told, rather than being quietly
    // rewritten into some other language's problem.
    expect(resolveTextLanguages({ sourceLanguage: "bs", targetLanguage: "bs" })).toBe(
      SAME_LANGUAGE
    );
  });
});

describe("the old direction string still means what it meant", () => {
  // docs/api-translation.md documents it and something outside this repo may
  // still send it. Honouring it costs two lines; breaking it costs a caller.
  it("reads en-es and es-en", () => {
    expect(resolveTextLanguages({ direction: "en-es" })).toEqual({
      pair: ["en", "es"],
      source: "en"
    });
    expect(resolveTextLanguages({ direction: "es-en" })).toEqual({
      pair: ["es", "en"],
      source: "es"
    });
  });

  it("loses to explicit language codes when both are sent", () => {
    // A caller mid-migration sending both means the codes: they are the
    // specific thing, the string is the legacy default.
    expect(
      resolveTextLanguages({ direction: "en-es", sourceLanguage: "en", targetLanguage: "bs" })
    ).toEqual({ pair: ["en", "bs"], source: "en" });
  });
});

describe("a request that names no languages", () => {
  it("falls back to the pair this app started life on, auto-detecting", () => {
    expect(resolveTextLanguages({})).toEqual({ pair: FALLBACK_PAIR, source: null });
    expect(resolveTextLanguages({ direction: "auto" })).toEqual({
      pair: FALLBACK_PAIR,
      source: null
    });
  });

  it("does not invent the other half from one side alone", () => {
    // "translate into Bosnian" with no source is not a pair. Guessing the
    // missing side is how you get a turn translated out of a language nobody
    // at the table was speaking.
    expect(resolveTextLanguages({ targetLanguage: "bs" })).toEqual({
      pair: FALLBACK_PAIR,
      source: null
    });
  });

  it("ignores a code that is not in the catalog", () => {
    expect(resolveTextLanguages({ sourceLanguage: "xx", targetLanguage: "zz" })).toEqual({
      pair: FALLBACK_PAIR,
      source: null
    });
  });
});

describe("otherSide", () => {
  it("answers with the side that isn't the one asked about", () => {
    expect(otherSide(["en", "bs"], "en")).toBe("bs");
    expect(otherSide(["en", "bs"], "bs")).toBe("en");
  });
});
