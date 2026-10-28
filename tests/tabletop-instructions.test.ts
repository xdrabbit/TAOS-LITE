// Pins the /tabletop live-interpreter fences. The wording matters as much as
// the presence — see lib/translate/prompts.ts for the 7/27 lesson that a
// fence describing the FAILURE MODE ("may be missing words") can induce it.
//
// The direction is a pair of catalog codes since 8/18 (it was an
// "en-es" | "es-en" string). Every fence below is the one that was here
// before; what is new is that they are checked in a language the table could
// not previously be set to.
import { describe, expect, it } from "vitest";
import { buildAutoInstructions, buildTurnInstructions } from "@/lib/tabletop/instructions";

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

// Auto-detect (Liz and Tom, 2026-10-27): one phone, two languages, nobody
// taps. The prompt names BOTH languages and adds exactly one rule — open every
// response with the OUTPUT language's tag — first and again last, the
// placement lesson from lib/live/instructions.ts.
describe("tabletop auto-detect instructions", () => {
  const p = buildAutoInstructions({ a: "es", b: "en" });

  it("names both languages of the pair, in either order", () => {
    expect(p).toContain("One speaks Spanish, the other speaks English");
    expect(p).toContain("Spanish into English, English into Spanish");
    const q = buildAutoInstructions({ a: "it", b: "bs" });
    expect(q).toContain("One speaks Italian, the other speaks Bosnian");
    expect(q).toContain("[it]");
    expect(q).toContain("[bs]");
  });

  it("puts the tag rule FIRST, with the exact catalog-code tags", () => {
    expect(p.startsWith("FORMAT: the first token of every response is the language tag")).toBe(true);
    const first = p.split(". ")[0];
    expect(first).toContain("exactly [es] for Spanish or [en] for English");
    expect(p).toContain("Nothing before the tag.");
  });

  it("repeats the tag rule as the final REMINDER", () => {
    const tail = p.slice(p.lastIndexOf("REMINDER:"));
    expect(tail).toBe(
      "REMINDER: start every response with [es] or [en] — the language you are writing — then the translation, and only the translation."
    );
  });

  it("keeps every interpreter rule the tapped turn has", () => {
    for (const rule of [
      "FIRST person — write AS the speaker, never about them",
      "Translate each phrase on its own; do not recap earlier phrases.",
      "NEVER converse",
      "NEVER invent content",
      "translate only the words you clearly heard",
      "never guess or complete the missing part"
    ]) {
      expect(p, rule).toContain(rule);
    }
  });

  it("carries the same meaning-first rule as the tapped turn, verbatim", () => {
    const tapped = buildTurnInstructions({ source: "es", target: "en" });
    // The sentence between the first-person rule and the no-recap rule.
    const between = (s: string) =>
      s.slice(
        s.indexOf("never about them.") + "never about them.".length,
        s.indexOf("Translate each phrase on its own")
      );
    expect(between(p)).toBe(between(tapped));
    expect(between(p).trim().length).toBeGreaterThan(0);
  });

  it("left the tapped-turn prompt exactly as it was", () => {
    const t = buildTurnInstructions({ source: "en", target: "es" });
    expect(t.startsWith("OUTPUT LANGUAGE: Spanish.")).toBe(true);
    expect(t.endsWith("REMINDER: output Spanish text and ONLY Spanish text.")).toBe(true);
    expect(t).not.toContain("[es]");
    expect(t).not.toContain("FORMAT:");
  });
});
