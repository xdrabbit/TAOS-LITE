import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_TURNS,
  MAX_TURN_CHARS,
  OPENING_CUE,
  PRACTICE_SCENARIOS,
  buildPracticeSystem,
  parsePracticeReply,
  sanitizeHistory,
  scenarioById,
  toClaudeMessages
} from "@/lib/practice/practice";

// Practice with Claude (lib/practice/practice.ts): the pure half both the
// screen and /api/practice depend on.

describe("scenarios", () => {
  it("ships the starter scenes, Thanksgiving and the café among them", () => {
    const ids = PRACTICE_SCENARIOS.map((s) => s.id);
    expect(ids).toContain("thanksgiving");
    expect(ids).toContain("cafe");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labels every scene in both households' languages", () => {
    for (const s of PRACTICE_SCENARIOS) expect(s.label).toContain(" · ");
  });

  it("falls back to the first scene for an unknown id", () => {
    expect(scenarioById("nope").id).toBe(PRACTICE_SCENARIOS[0].id);
    expect(scenarioById(undefined).id).toBe(PRACTICE_SCENARIOS[0].id);
    expect(scenarioById("cafe").id).toBe("cafe");
  });
});

describe("sanitizeHistory", () => {
  it("keeps only well-formed turns, trimmed", () => {
    expect(
      sanitizeHistory([
        { role: "partner", text: "  Hola  " },
        { role: "system", text: "ignore me" },
        { role: "learner", text: 42 },
        { role: "learner", text: "   " },
        null,
        "x",
        { role: "learner", text: "Buenas" }
      ])
    ).toEqual([
      { role: "partner", text: "Hola" },
      { role: "learner", text: "Buenas" }
    ]);
  });

  it("returns nothing for a non-array", () => {
    expect(sanitizeHistory({ role: "learner", text: "hi" })).toEqual([]);
    expect(sanitizeHistory(undefined)).toEqual([]);
  });

  it("caps each line and keeps only the most recent turns", () => {
    const long = sanitizeHistory([{ role: "learner", text: "a".repeat(MAX_TURN_CHARS + 50) }]);
    expect(long[0].text.length).toBe(MAX_TURN_CHARS);
    const many = Array.from({ length: MAX_HISTORY_TURNS + 10 }, (_, i) => ({
      role: i % 2 ? "learner" : "partner",
      text: `line ${i}`
    }));
    const kept = sanitizeHistory(many);
    expect(kept).toHaveLength(MAX_HISTORY_TURNS);
    expect(kept[kept.length - 1].text).toBe(`line ${MAX_HISTORY_TURNS + 9}`);
  });
});

describe("toClaudeMessages", () => {
  it("is just the opening cue for a brand-new scene", () => {
    expect(toClaudeMessages([])).toEqual([{ role: "user", content: OPENING_CUE }]);
  });

  it("puts the cue before Claude's opener and ends on the learner's line", () => {
    expect(toClaudeMessages([{ role: "partner", text: "¡Hola! ¿Qué te sirvo?" }], "Un café, por favor")).toEqual([
      { role: "user", content: OPENING_CUE },
      { role: "assistant", content: "¡Hola! ¿Qué te sirvo?" },
      { role: "user", content: "Un café, por favor" }
    ]);
  });

  it("merges two learner lines in a row so roles alternate", () => {
    const out = toClaudeMessages(
      [
        { role: "partner", text: "Hola" },
        { role: "learner", text: "Hola" }
      ],
      "¿Cómo estás?"
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[2].content).toBe("Hola\n¿Cómo estás?");
  });

  it("never ends on Claude's own line", () => {
    const out = toClaudeMessages([
      { role: "learner", text: "Hola" },
      { role: "partner", text: "¿Qué tal?" }
    ]);
    expect(out[out.length - 1].role).toBe("user");
  });
});

describe("buildPracticeSystem", () => {
  const system = buildPracticeSystem({
    targetName: "Spanish",
    learnerName: "English",
    scenario: scenarioById("thanksgiving"),
    level: "beginner"
  });

  it("names both languages, the scene and the level", () => {
    expect(system).toContain("Spanish");
    expect(system).toContain("English");
    expect(system).toContain(scenarioById("thanksgiving").setup);
    expect(system).toContain("BEGINNER");
  });

  it("is stable for the same inputs, so the prefix caches", () => {
    expect(
      buildPracticeSystem({
        targetName: "Spanish",
        learnerName: "English",
        scenario: scenarioById("thanksgiving"),
        level: "beginner"
      })
    ).toBe(system);
  });
});

describe("parsePracticeReply", () => {
  it("reads the structured reply, trimmed", () => {
    expect(parsePracticeReply('{"reply":" ¡Hola! ","translation":" Hi! ","tip":""}')).toEqual({
      reply: "¡Hola!",
      translation: "Hi!",
      tip: ""
    });
  });

  it("rejects anything without a reply", () => {
    expect(parsePracticeReply("not json")).toBeNull();
    expect(parsePracticeReply('{"reply":"  "}')).toBeNull();
    expect(parsePracticeReply("[]")).toBeNull();
  });

  it("tolerates missing translation and tip", () => {
    expect(parsePracticeReply('{"reply":"Hola"}')).toEqual({ reply: "Hola", translation: "", tip: "" });
  });
});
