// What the tutor is told to be, in each phase — and the fence that keeps the
// tutor from growing a two-language ceiling back.
//
// The ceiling is not hypothetical here. Until phase 1 the tutor route carried
//
//     type LearnLang = "es" | "en";
//     const targetName = opts.learn === "es" ? "Spanish" : "English";
//
// which is the same shape that had /call interpreting into the wrong language
// on a trip (lib/release.ts). A tutor built on it can teach exactly two of the
// catalog's hundred languages, and fails by teaching the WRONG one rather than
// by erroring.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTutorInstructions } from "@/lib/tutor/instructions";
import { getTutorModule } from "@/lib/tutor/modules";
import type { Lesson } from "@/lib/tutor/lesson";

const needs = getTutorModule("needs-wants")!;

const lesson: Lesson = {
  moduleId: "needs-wants",
  target: "it",
  learner: "es",
  title: "Chiedere quello che serve",
  contrastHook: { headline: "h", explanation: "e", sameAsLearner: true },
  phrases: [
    { move: "request", target: "Ho bisogno di un'aspirina", meaning: "Necesito una aspirina" },
    { move: "thank", target: "Grazie", meaning: "Gracias" }
  ],
  pronunciation: [{ slot: "request_phrase", phrase: "Ho bisogno di un'aspirina" }],
  roleplay: {
    setting: "una farmacia a Roma",
    tutorRole: "il farmacista",
    learnerRole: "il viaggiatore",
    opening: { cue: "entri", target: "Buongiorno, mi dica", meaning: "Buenos días" },
    learnerLines: [
      { cue: "te saluda", target: "Ho bisogno di qualcosa per il mal di testa", meaning: "Necesito algo para el dolor de cabeza" },
      { cue: "te ofrece otra cosa", target: "No, grazie", meaning: "No, gracias" }
    ]
  },
  runGoal: "Chiedere e gestire un no."
};

describe("the languages come from the catalog", () => {
  it("names a pair the old tutor could not have taught", () => {
    const text = buildTutorInstructions({
      target: "it",
      learner: "es",
      level: "beginner",
      phase: "partner"
    });
    expect(text).toContain("Italian");
    expect(text).toContain("Spanish speaker learning Italian");
    // The two names the hardcoded version always produced.
    expect(text).not.toContain("English");
  });

  it("uses the learner's own language as the fallback, whatever it is", () => {
    const text = buildTutorInstructions({
      target: "ja",
      learner: "pt",
      level: "beginner",
      phase: "partner"
    });
    expect(text).toContain("drop into Portuguese briefly");
    expect(text).toContain("use more Portuguese");
  });

  it("keeps the level ladder", () => {
    const beginner = buildTutorInstructions({ target: "es", learner: "en", level: "beginner", phase: "partner" });
    const advanced = buildTutorInstructions({ target: "es", learner: "en", level: "advanced", phase: "partner" });
    expect(beginner).toContain("BEGINNER");
    expect(advanced).toContain("ADVANCED");
    expect(advanced).toContain("normal pace");
  });
});

describe("Walk — the scripted roleplay", () => {
  const text = buildTutorInstructions({
    target: "it",
    learner: "es",
    level: "beginner",
    phase: "walk",
    module: needs,
    lesson
  });

  it("puts the tutor in the lesson's role, in the lesson's scene", () => {
    expect(text).toContain("una farmacia a Roma");
    expect(text).toContain("il farmacista");
    expect(text).toContain("Buongiorno, mi dica");
  });

  it("steers toward the learner's lines without saying them", () => {
    // The point of Walk is that the LEARNER produces these. A tutor that
    // reads them aloud has turned the rehearsal into a listening exercise.
    expect(text).toContain("Ho bisogno di qualcosa per il mal di testa");
    expect(text).toContain("Do NOT say the learner's lines for them");
  });

  it("still runs off the module alone when no lesson was cached", () => {
    const fallback = buildTutorInstructions({
      target: "it",
      learner: "es",
      level: "beginner",
      phase: "walk",
      module: needs
    });
    expect(fallback).toContain(needs.roleplaySeed);
  });
});

describe("Run — free conversation, gently kept in-module", () => {
  const text = buildTutorInstructions({
    target: "it",
    learner: "es",
    level: "intermediate",
    phase: "run",
    module: needs,
    lesson
  });

  it("names the module's competency as the boundary", () => {
    expect(text).toContain(needs.competency);
  });

  it("steers back without announcing it", () => {
    expect(text).toContain("Never announce that you are steering");
  });

  it("offers the studied phrases as openings, not as demands", () => {
    expect(text).toContain("Ho bisogno di un'aspirina");
    expect(text).toContain("never demand them verbatim");
  });
});

describe("Partner — no curriculum", () => {
  const text = buildTutorInstructions({
    target: "es",
    learner: "en",
    level: "intermediate",
    phase: "partner",
    focus: "kitchen words"
  });

  it("takes a free-text focus", () => {
    expect(text).toContain("kitchen words");
  });

  it("mentions no module and no scene", () => {
    expect(text).not.toContain("SCENE");
    expect(text).not.toContain("KEEP THE CONVERSATION INSIDE THIS TOPIC");
  });
});

describe("the tutor keeps no private language table", () => {
  // Source-reading, like tests/screen-language-wiring.test.ts, and for the
  // same reason: the ceiling comes back as a literal, not as a failing call.
  function code(path: string): string {
    return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .map((line) => line.replace(/\s+\/\/(?!\/).*$/, ""))
      .join("\n");
  }

  it("has no LearnLang union left in the realtime route or its client", () => {
    for (const path of ["app/api/tutor/realtime/route.ts", "lib/tutor/conversation.ts"]) {
      expect(code(path), path).not.toMatch(/type\s+LearnLang/);
      expect(code(path), path).not.toMatch(/"es"\s*\|\s*"en"|"en"\s*\|\s*"es"/);
    }
  });

  it("carries the persona on every one-off turn", () => {
    // `response.instructions` REPLACES the session instructions for that
    // response rather than adding to them, so a bare nudge silently strips the
    // persona for exactly one turn. That is how the first line of a Walk scene
    // came back as a cheerful general-purpose assistant in English instead of
    // the pharmacist's opening (found driving a real session, 8/25). Every
    // response.create in the client goes through one helper that prepends the
    // persona; this is the fence that keeps a second, bare one from appearing.
    const src = code("lib/tutor/conversation.ts");
    const bareTurns = src.match(/type:\s*"response\.create"/g) ?? [];
    expect(bareTurns).toHaveLength(1);
    expect(src).toMatch(/instructions:\s*`\$\{baseInstructions\}/);
  });

  it("builds its persona from the catalog, in one place", () => {
    expect(code("lib/tutor/instructions.ts")).toContain("languageLabel");
    // The route imports the builder rather than keeping its own copy.
    expect(code("app/api/tutor/realtime/route.ts")).toContain(
      'from "@/lib/tutor/instructions"'
    );
  });
});
