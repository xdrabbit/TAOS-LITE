// /live's two prompts, and the language ceiling they used to carry.
//
// Both of these had an {en, es} table written into them until 8/18 — the
// ambient interpreter picked its two names with a ternary, and the on-device
// concept endpoint had a DIRECTION_LABELS map keyed by "es-en"|"en-es". A
// language reaching either of them raw ("output language: it") is the failure
// this file exists to catch: the model does not error on that, it just
// answers in whatever language it feels like, which nobody on the receiving
// end can recognize as broken.
import { describe, expect, it } from "vitest";
import {
  buildConceptInstructions,
  buildInterpreterInstructions
} from "@/lib/live/instructions";

describe("ambient interpreter instructions", () => {
  it("names both sides, in English, from the catalog", () => {
    const p = buildInterpreterInstructions("en", "es");
    expect(p).toContain("OUTPUT LANGUAGE: English");
    expect(p).toContain("You hear Spanish");
    expect(p).toContain("you NEVER output Spanish");
  });

  it("reaches languages /live could not previously follow", () => {
    // The trip case: standing in a room where Bosnian is being spoken and
    // wanting it in English.
    const p = buildInterpreterInstructions("en", "bs");
    expect(p).toContain("OUTPUT LANGUAGE: English");
    expect(p).toContain("You hear Bosnian");

    // And the other way: Liz following an Italian table in Spanish.
    const q = buildInterpreterInstructions("es", "it");
    expect(q).toContain("OUTPUT LANGUAGE: Spanish");
    expect(q).toContain("You hear Italian");
  });

  it("never interpolates a bare code — the model would not know what to do", () => {
    // A code that slipped through as a label reads as "OUTPUT LANGUAGE: th",
    // which is the whole reason languageLabel() is load-bearing.
    const p = buildInterpreterInstructions("th", "vi");
    expect(p).toContain("OUTPUT LANGUAGE: Thai");
    expect(p).not.toContain("OUTPUT LANGUAGE: th.");
  });

  it("keeps the fences that stopped the 7/8 hallucinations", () => {
    const p = buildInterpreterInstructions("en", "es");
    expect(p).toContain("NEVER converse");
    expect(p).toContain("NEVER invent content");
    expect(p).toContain("An empty response is always better than an invented one");
    // The repeat at the end is deliberate: burying the output-language rule
    // mid-prompt is what let the model drift into the source language.
    expect(p).toContain("REMINDER: your output language is English and ONLY English");
  });
});

describe("on-device concept instructions", () => {
  it("names the pair it was handed", () => {
    const p = buildConceptInstructions("es", "en");
    expect(p).toContain("follow a live Spanish conversation in English");
    expect(p).toContain("fragmentary chunk of Spanish speech");
    expect(p).toContain("3 to 12 words in English");
  });

  it("works in any direction over the catalog", () => {
    const p = buildConceptInstructions("ja", "it");
    expect(p).toContain("follow a live Japanese conversation in Italian");
    expect(p).toContain("3 to 12 words in Italian");
  });

  it("still asks for a concept, not a translation, and still marks guesses", () => {
    // /live's whole bargain: freshness over fidelity, with the "~" admitting
    // when a summary is more prediction than content.
    const p = buildConceptInstructions("es", "en");
    expect(p).toContain("Do NOT translate word for word");
    expect(p).toContain("CORE CONCEPT");
    expect(p).toContain('prefix it with "~"');
  });
});
