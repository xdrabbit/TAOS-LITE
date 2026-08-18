// Pins the /tabletop live-interpreter fences. The wording matters as much as
// the presence — see lib/translate/prompts.ts for the 7/27 lesson that a
// fence describing the FAILURE MODE ("may be missing words") can induce it.
//
// The direction is a pair of catalog codes since 8/18 (it was an
// "en-es" | "es-en" string). Every fence below is the one that was here
// before; what is new is that they are checked in a language the table could
// not previously be set to.
import { describe, expect, it } from "vitest";
import { buildTurnInstructions } from "@/lib/tabletop/instructions";

describe("tabletop turn instructions", () => {
  it("names the right languages per direction", () => {
    expect(buildTurnInstructions({ source: "en", target: "es" })).toContain(
      "OUTPUT LANGUAGE: Spanish"
    );
    expect(buildTurnInstructions({ source: "es", target: "en" })).toContain(
      "OUTPUT LANGUAGE: English"
    );
  });

  it("names any pair in the catalog, not just the two it shipped with", () => {
    // The whole point of the change: a phone handed across a table in Mostar
    // has to be able to say "OUTPUT LANGUAGE: Bosnian".
    const p = buildTurnInstructions({ source: "it", target: "bs" });
    expect(p).toContain("OUTPUT LANGUAGE: Bosnian");
    expect(p).toContain("ONE person is speaking Italian");
    expect(p).toContain("output Bosnian text and ONLY Bosnian text");
  });

  it("names a tier-2 language the same way — text is the deliverable", () => {
    // Tier 2 (lib/languages/catalog.ts) changes nothing about the prompt:
    // the translation is just as good, it simply never reaches /api/tts.
    expect(buildTurnInstructions({ source: "en", target: "th" })).toContain(
      "OUTPUT LANGUAGE: Thai"
    );
  });

  it("keeps the interpreter fences: never converse, never invent", () => {
    const p = buildTurnInstructions({ source: "en", target: "es" });
    expect(p).toContain("NEVER converse");
    expect(p).toContain("NEVER invent content");
  });

  it("carries the 7/27 gap rule: partial phrases are never completed", () => {
    const p = buildTurnInstructions({ source: "es", target: "en" });
    expect(p).toContain("translate only the words you clearly heard");
    expect(p).toContain("never guess or complete the missing part");
  });

  it("still writes AS the speaker, in the first person", () => {
    expect(buildTurnInstructions({ source: "ja", target: "en" })).toContain(
      "FIRST person — write AS the speaker, never about them"
    );
  });
});
