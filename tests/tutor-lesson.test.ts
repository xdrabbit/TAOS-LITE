// The generation contract: what the model is asked for, what is accepted back,
// and what the cache is keyed on.
//
// These are the rules that decide whether a lesson in a structurally different
// language is a lesson or a mistranslation, and none of them can be checked on
// a phone without paying for a completion first — which is exactly why the
// prompt and the parser live in lib/tutor/lesson.ts rather than in the route.
import { describe, expect, it } from "vitest";
import {
  LESSON_PROMPT_VERSION,
  LessonParseError,
  buildLessonPrompt,
  lessonCacheKey,
  parseLesson
} from "@/lib/tutor/lesson";
import { getTutorModule } from "@/lib/tutor/modules";

const needs = getTutorModule("needs-wants")!;

describe("the generation prompt", () => {
  it("names both languages by their English catalog labels", () => {
    const { system, user } = buildLessonPrompt({ module: needs, target: "hi", learner: "en" });
    expect(system).toContain("Hindi");
    expect(system).toContain("English");
    expect(user).toContain(needs.competency);
    expect(user).toContain(needs.roleplaySeed);
  });

  it("contrasts against the LEARNER's language, not against English", () => {
    // Liz learning Hindi needs the comparison with Spanish. A prompt that
    // silently used English as the baseline would be teaching her someone
    // else's lesson — and would read as correct in every EN-learner test.
    const { system } = buildLessonPrompt({ module: needs, target: "hi", learner: "es" });
    expect(system).toContain("whose own language is Spanish");
    expect(system).toContain("Compare how Hindi builds this intent with how Spanish builds it");
    expect(system).toContain("Do not compare against English unless English IS the learner's language");
  });

  it("hands the module's contrast focus over as a hint, not an answer", () => {
    const { user } = buildLessonPrompt({ module: needs, target: "es", learner: "en" });
    expect(user).toContain(needs.contrastFocus);
    expect(user).toContain("ignore it entirely if it does not");
  });

  it("lets the model say the two languages match, rather than inventing a difference", () => {
    // EN→ES really does map word-for-word for most of these modules. A
    // generator with no way to say so will manufacture a contrast, and a
    // manufactured contrast is worse than none: it teaches the learner not to
    // trust the real ones.
    const { system } = buildLessonPrompt({ module: needs, target: "es", learner: "en" });
    expect(system).toContain("sameAsLearner to true");
    expect(system).toContain("never invent a difference");
  });

  it("demands a romanization for every phrase in a text-only language", () => {
    // Persian is tier 2 (lib/languages/catalog.ts): the app will never speak
    // it, so the written page is the only pronunciation teacher there is.
    const { user } = buildLessonPrompt({ module: needs, target: "fa", learner: "en" });
    expect(user).toContain("TEXT ONLY");
    expect(user).toContain("romanization for EVERY phrase");
  });

  it("asks for a romanization only where the script needs one", () => {
    const { user } = buildLessonPrompt({ module: needs, target: "es", learner: "en" });
    expect(user).not.toContain("TEXT ONLY");
    expect(user).toContain("non-Latin script");
  });

  it("asks for one phrase per core move and one entry per pronunciation slot", () => {
    const { user } = buildLessonPrompt({ module: needs, target: "es", learner: "en" });
    expect(user).toContain(needs.coreMoves.join(", "));
    expect(user).toContain(needs.pronunciationTargets.join(", "));
  });
});

describe("the cache key", () => {
  it("is module × target × learner, per the plan", () => {
    expect(lessonCacheKey("needs-wants", "es", "en")).toBe(
      `needs-wants:es:en:v${LESSON_PROMPT_VERSION}`
    );
  });

  it("does not vary by level", () => {
    // Level changes how the tutor SPEAKS (lib/tutor/instructions.ts), not
    // which phrases the module teaches. Keying on it would triple the
    // generation bill to produce three identical pages.
    const a = lessonCacheKey("needs-wants", "es", "en");
    const b = lessonCacheKey("needs-wants", "es", "en");
    expect(a).toBe(b);
  });

  it("separates the two directions of a pair", () => {
    expect(lessonCacheKey("needs-wants", "es", "en")).not.toBe(
      lessonCacheKey("needs-wants", "en", "es")
    );
  });

  it("carries the prompt version, so a prompt change retires the old rows", () => {
    expect(lessonCacheKey("needs-wants", "es", "en")).toContain(`v${LESSON_PROMPT_VERSION}`);
  });
});

// A minimal well-formed lesson, as the model would return it.
function goodLesson(): Record<string, unknown> {
  return {
    title: "Pedir lo que necesitas",
    contrastHook: {
      headline: "El hindi pone a la persona en dativo",
      explanation: "En hindi lo que se quiere es el sujeto y la persona va en dativo.",
      sameAsLearner: false,
      example: {
        move: "request",
        target: "मुझे पानी चाहिए",
        romanization: "mujhe paani chaahiye",
        meaning: "Necesito agua",
        literal: "a-mí agua es-querida"
      }
    },
    phrases: [
      { move: "request", target: "मुझे पानी चाहिए", meaning: "Necesito agua" },
      { move: "quantity", target: "दो", meaning: "dos" },
      { move: "accept", target: "ठीक है", meaning: "está bien" },
      { move: "thank", target: "धन्यवाद", meaning: "gracias" }
    ],
    pronunciation: [
      { slot: "request_phrase", phrase: "मुझे पानी चाहिए", why: "la retrofleja" },
      { slot: "thank_phrase", phrase: "धन्यवाद" }
    ],
    roleplay: {
      setting: "una farmacia",
      tutorRole: "farmacéutico",
      learnerRole: "viajero",
      opening: { cue: "entra", target: "नमस्ते", meaning: "hola" },
      learnerLines: [
        { cue: "te saluda", target: "मुझे दवा चाहिए", meaning: "necesito medicina" },
        { cue: "te ofrece otra cosa", target: "नहीं, धन्यवाद", meaning: "no, gracias" }
      ]
    },
    runGoal: "Pedir algo y manejar un no."
  };
}

describe("parsing what comes back", () => {
  const context = { module: needs, target: "hi", learner: "es" };

  it("accepts a well-formed lesson", () => {
    const lesson = parseLesson(goodLesson(), context);
    expect(lesson.moduleId).toBe("needs-wants");
    expect(lesson.target).toBe("hi");
    expect(lesson.learner).toBe("es");
    expect(lesson.phrases).toHaveLength(4);
    expect(lesson.contrastHook.example?.literal).toBe("a-mí agua es-querida");
    expect(lesson.promptVersion).toBe(LESSON_PROMPT_VERSION);
  });

  it("accepts JSON that arrived inside a markdown fence", () => {
    const raw = "```json\n" + JSON.stringify(goodLesson()) + "\n```";
    expect(parseLesson(raw, context).title).toBe("Pedir lo que necesitas");
  });

  it("refuses a lesson with no contrast hook", () => {
    // The hook is most of what a lesson IS. Caching a lesson without one
    // would serve the gap to everyone who asks for that pair, forever.
    const raw = goodLesson();
    delete (raw as Record<string, unknown>).contrastHook;
    expect(() => parseLesson(raw, context)).toThrow(LessonParseError);
  });

  it("refuses a lesson with nothing to pronounce", () => {
    const raw = { ...goodLesson(), pronunciation: [] };
    expect(() => parseLesson(raw, context)).toThrow(LessonParseError);
  });

  it("refuses a lesson with no usable roleplay", () => {
    const raw = { ...goodLesson(), roleplay: { setting: "una farmacia" } };
    expect(() => parseLesson(raw, context)).toThrow(LessonParseError);
  });

  it("drops pronunciation slots the module never asked for", () => {
    // Crawl scores against the module's declared targets; a slot from
    // somewhere else would put a phrase on the drill card that nothing else
    // in the lesson knows about.
    const raw = goodLesson();
    (raw.pronunciation as unknown[]).push({ slot: "greet_phrase", phrase: "नमस्ते" });
    const lesson = parseLesson(raw, context);
    expect(lesson.pronunciation.map((p) => p.slot)).toEqual([
      "request_phrase",
      "thank_phrase"
    ]);
  });

  it("drops half-written phrases instead of rendering blanks", () => {
    const raw = goodLesson();
    (raw.phrases as unknown[]).push({ move: "decline", target: "", meaning: "no" });
    expect(parseLesson(raw, context).phrases).toHaveLength(4);
  });

  it("refuses text that is not JSON at all", () => {
    expect(() => parseLesson("I'm sorry, I can't help with that.", context)).toThrow(
      LessonParseError
    );
  });
});
