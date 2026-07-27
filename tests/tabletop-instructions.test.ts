// Pins the /tabletop live-interpreter fences. The wording matters as much as
// the presence — see lib/translate/prompts.ts for the 7/27 lesson that a
// fence describing the FAILURE MODE ("may be missing words") can induce it.
import { describe, expect, it } from "vitest";
import { buildTurnInstructions } from "@/lib/tabletop/instructions";

describe("tabletop turn instructions", () => {
  it("names the right languages per direction", () => {
    expect(buildTurnInstructions("en-es")).toContain("OUTPUT LANGUAGE: Spanish");
    expect(buildTurnInstructions("es-en")).toContain("OUTPUT LANGUAGE: English");
  });

  it("keeps the interpreter fences: never converse, never invent", () => {
    const p = buildTurnInstructions("en-es");
    expect(p).toContain("NEVER converse");
    expect(p).toContain("NEVER invent content");
  });

  it("carries the 7/27 gap rule: partial phrases are never completed", () => {
    const p = buildTurnInstructions("es-en");
    expect(p).toContain("translate only the words you clearly heard");
    expect(p).toContain("never guess or complete the missing part");
  });
});
