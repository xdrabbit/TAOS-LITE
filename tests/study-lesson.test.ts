// Fences for the Study lesson engine (lib/study/lesson.ts), a port of the
// viewer prototype that a stress run judged good.
//
// Nothing here talks to OpenAI. What is pinned is everything around the call:
// which side of a row is "the language being learned", what the model is
// told, how its answer is validated and shaped, and the key a lesson is saved
// under — because every one of those is a decision the prototype paid to get
// right, and a port that drifts on any of them is an untested prompt.
import { describe, expect, it } from "vitest";
import {
  MAX_CHUNKS,
  STUDY_LESSON_SCHEMA,
  StudyLessonParseError,
  buildStudyPrompt,
  capChunks,
  cleanTrap,
  languageName,
  languagesIn,
  parseStudyLesson,
  studyLessonKey,
  targetSide
} from "@/lib/study/lesson";
import type { StudySource } from "@/lib/study/types";

const ROW: StudySource = {
  id: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-09-13T20:00:00.000Z",
  session_id: null,
  source_lang: "es",
  target_lang: "en",
  original_text: "Voy en camino.",
  translation_text: "I'm on my way."
};

describe("targetSide", () => {
  it("defaults to the non-English side, explained from the English one", () => {
    expect(targetSide(ROW)).toMatchObject({ lang: "es", text: "Voy en camino.", other: "I'm on my way.", otherLang: "en" });
    expect(targetSide({ ...ROW, source_lang: "en", target_lang: "es", original_text: "Hi", translation_text: "Hola" })).toMatchObject({
      lang: "es",
      text: "Hola"
    });
  });

  it("picks the requested language from either side, and null when it has none", () => {
    expect(targetSide(ROW, "en")).toMatchObject({ lang: "en", text: "I'm on my way.", other: "Voy en camino." });
    expect(targetSide(ROW, "it")).toBeNull();
  });

  it("languagesIn lists every language on the rows", () => {
    expect(languagesIn([ROW]).sort()).toEqual(["en", "es"]);
  });

  it("languageName reads a code, with the code itself as the fallback", () => {
    expect(languageName("es")).toBe("Spanish");
    expect(languageName(null)).toBe("the target language");
  });
});

describe("buildStudyPrompt", () => {
  it("tells the model which language to teach and which to write in", () => {
    const p = buildStudyPrompt({ records: [ROW] });
    expect(p.lang).toBe("es");
    expect(p.explain).toBe("en");
    expect(p.system).toContain("You are a patient Spanish teacher for an adult native English speaker.");
    expect(p.system).toContain("WRITE THE LESSON IN ENGLISH");
    expect(p.system).toContain('"target_language": the ISO code, "es".');
  });

  it("flips cleanly for Liz: English, explained in Spanish", () => {
    const p = buildStudyPrompt({ records: [ROW], target: "en", explain: "es" });
    expect(p.system).toContain("You are a patient English teacher for an adult native Spanish speaker.");
    expect(p.system).toContain("WRITE THE LESSON IN SPANISH");
    // The trap a Spanish speaker actually falls into, not the one an English
    // speaker does.
    expect(p.system).toContain('"Is raining"');
    expect(p.system).not.toContain('"dije te"');
  });

  it("keeps colloquial speech and refuses to teach an error as correct", () => {
    const p = buildStudyPrompt({ records: [ROW] });
    expect(p.system).toContain("Never teach an error as correct.");
    expect(p.system).toContain("COLLOQUIAL speech is not an");
  });

  it("puts the record, the selection and the context in the user turn — context marked do-not-teach", () => {
    const ctx: StudySource = { ...ROW, id: "22222222-2222-4222-8222-222222222222", original_text: "¿Dónde estás?", translation_text: "Where are you?" };
    const p = buildStudyPrompt({ selection: "en camino", records: [ROW], context: [ctx] });
    expect(p.user).toContain('The learner highlighted:\n"""en camino"""');
    expect(p.user).toContain("Spanish: Voy en camino.");
    expect(p.user).toContain("English: I'm on my way.");
    expect(p.user).toContain("for context only — do not teach these");
    expect(p.user).toContain("- ¿Dónde estás?  |  Where are you?");
  });

  it("asks for a strict schema with every field the card renders", () => {
    const props = STUDY_LESSON_SCHEMA.schema.properties.sentences.items.properties;
    for (const key of ["target", "as_said", "english", "words", "english_order_trap", "order_points", "context_meaning", "register", "chunks"]) {
      expect(props).toHaveProperty(key);
    }
    expect(STUDY_LESSON_SCHEMA.strict).toBe(true);
  });
});

describe("parseStudyLesson", () => {
  const good = JSON.stringify({
    target_language: "es",
    caveats: "",
    sentences: [
      {
        target: "Voy en camino.",
        as_said: "",
        english: "I'm on my way.",
        words: [
          { text: "Voy", lemma: "ir", gloss: "I go", literal: "I-go", role: "verb", note: "subject is inside the verb" },
          { text: "en", lemma: "en", gloss: "on", literal: "on", role: "preposition", note: "" },
          { text: "camino", lemma: "camino", gloss: "way", literal: "way", role: "noun", note: "" }
        ],
        english_order_trap: '"Yo voy en el camino" — English pushes you toward an article',
        order_points: [{ rule: "No subject pronoun", explanation: "Voy already says I.", example: "Vengo mañana." }],
        context_meaning: "A quick heads-up that he's left.",
        register: "tú, casual",
        chunks: ["camino", "en camino", "Voy en camino."]
      }
    ]
  });

  it("assembles the word-for-word line from the words, never from the model", () => {
    const lesson = parseStudyLesson(good, "en");
    expect(lesson.sentences[0].literal).toBe("I-go on way");
    expect(lesson.explain_language).toBe("en");
    expect(lesson.target_language).toBe("es");
  });

  it("strips commentary and quotes off the struck-through trap", () => {
    expect(parseStudyLesson(good, "en").sentences[0].english_order_trap).toBe("Yo voy en el camino");
  });

  it("rejects an answer with nothing to teach, loudly", () => {
    expect(() => parseStudyLesson("not json", "en")).toThrow(StudyLessonParseError);
    expect(() => parseStudyLesson(JSON.stringify({ sentences: [] }), "en")).toThrow(/without any sentences/);
    expect(() => parseStudyLesson(JSON.stringify({ sentences: [{ target: "x", words: [] }] }), "en")).toThrow(StudyLessonParseError);
  });
});

describe("cleanTrap / capChunks", () => {
  it("drops a trailing em-dash commentary and wrapping quotes", () => {
    expect(cleanTrap('"Is raining" — Spanish drops the subject')).toBe("Is raining");
    // A LEADING asterisk is dropped — the model sometimes opens with markdown
    // emphasis. A trailing one is not pinned: the prototype never saw it, and
    // a faithful port must not invent behaviour the stress run never judged.
    expect(cleanTrap("*The car red – adjective order")).toBe("The car red");
    expect(cleanTrap("  plain  ")).toBe("plain");
    expect(cleanTrap(null)).toBe("");
  });

  it("keeps a hyphen that is part of the sentence", () => {
    expect(cleanTrap("a well-known mistake")).toBe("a well-known mistake");
  });

  it("caps the ladder at MAX_CHUNKS, keeping the first and the last rung", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `rung ${i}`);
    const out = capChunks(ten);
    expect(out).toHaveLength(MAX_CHUNKS);
    expect(out[0]).toBe("rung 0");
    expect(out[out.length - 1]).toBe("rung 9");
    expect(capChunks(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("studyLessonKey", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  it("does not care what order the rows were picked in", () => {
    expect(studyLessonKey([A, B], "", "es", "en")).toBe(studyLessonKey([B, A], "", "es", "en"));
  });

  it("is a different lesson in the other direction, and for a different selection", () => {
    expect(studyLessonKey([A], "", "es", "en")).not.toBe(studyLessonKey([A], "", "en", "es"));
    expect(studyLessonKey([A], "camino", "es", "en")).not.toBe(studyLessonKey([A], "", "es", "en"));
    expect(studyLessonKey([A], "  camino ", "es", "en")).toBe(studyLessonKey([A], "camino", "es", "en"));
  });

  it("is sixteen hex characters", () => {
    expect(studyLessonKey([A], "", "es", "en")).toMatch(/^[0-9a-f]{16}$/);
  });
});
