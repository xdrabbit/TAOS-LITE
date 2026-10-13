import { describe, expect, it } from "vitest";
import { applyPracticeEvaluation, isEnglishHintRequest, freshPractice, parsePracticeProgress, parseStudyRef, practiceStateBlock, practiceStorageKey, resolveStudyContext, studyInstructions, studyContextKey, studyPracticeHref, studyRefFromQuery } from "@/lib/tutor/studyPractice";
import { lesson } from "./fixtures/study-tutor";

const ref = { lessonKey: "saved-key", sentenceIndex: 0 };
const answer = (result: string, stage = "construction") => ({ result, stage, meaningPreserved: true, tensePreserved: true, error: "Use haya venido for this reaction", prompt: "Say I'm surprised that he came" });
describe("Study context", () => {
  it("carries full parent context when a ladder phrase is selected", () => {
    const context = resolveStudyContext(lesson, { ...ref, chunkIndex: 0 });
    expect(context?.phrase).toBe("haya venido");
    expect(context?.sentence.order_points[0].rule).toBe("subjunctive");
    expect(resolveStudyContext(lesson, { ...ref, sentenceIndex: 2 })).toBeNull();
    expect(resolveStudyContext(lesson, { ...ref, chunkIndex: 99 })).toBeNull();
  });
  it("isolates progress and rejects stale selections after lesson regeneration", () => {
    const original = { ...ref, contextKey: studyContextKey(lesson.sentences[0]) };
    const changed = { ...lesson, sentences: [{ ...lesson.sentences[0], target: "Me alegra que haya venido." }] };
    expect(resolveStudyContext(lesson, original)).not.toBeNull();
    expect(resolveStudyContext(changed, original)).toBeNull();
    expect(practiceStorageKey("tom", original)).not.toBe(practiceStorageKey("tom", { ...original, contextKey: studyContextKey(changed.sentences[0]) }));
  });
  it("roundtrips references without putting sentence contents in URLs", () => {
    const href = studyPracticeHref({ ...ref, chunkIndex: 1 }, "es", "en");
    expect(studyRefFromQuery(new URL(href, "https://taos.test").searchParams)).toEqual({ ...ref, chunkIndex: 1 });
    expect(href).not.toContain("sorprende");
    for (const value of [null, {}, { ...ref, sentenceIndex: -1 }, { ...ref, chunkIndex: 0.5 }, { ...ref, lessonKey: "x".repeat(201) }]) expect(parseStudyRef(value)).toBeNull();
  });
});
describe("adaptive retry and progress", () => {
  it("holds construction on the smallest error, then transfers after a successful retry", () => {
    const failed = applyPracticeEvaluation(freshPractice(), answer("partial"), "now");
    expect(failed).toMatchObject({ stage: "construction", retry: true, attempts: 1, successes: 0, updatedAt: "now" });
    expect(practiceStateBlock(failed)).toContain("Require a retry");
    expect(failed.prompt).toBe(answer("partial").prompt);
    const wrongStage = applyPracticeEvaluation(failed, answer("correct", "transfer"));
    expect(wrongStage).toBe(failed);
    const passed = applyPracticeEvaluation(failed, answer("correct"));
    expect(passed).toMatchObject({ stage: "transfer", retry: false, attempts: 2, successes: 1, error: "", prompt: "" });
    const transferMiss = applyPracticeEvaluation(passed, answer("incorrect", "transfer"));
    expect(transferMiss).toMatchObject({ stage: "transfer", retry: true, successes: 1 });
    expect(applyPracticeEvaluation(transferMiss, answer("correct", "transfer")).successes).toBe(2);
  });
  it("requires the requested tense and meaning on the retry before advancing", () => {
    const p = applyPracticeEvaluation(freshPractice(), answer("incorrect"));
    const wrongTense = applyPracticeEvaluation(p, { ...answer("correct"), tensePreserved: false });
    expect(wrongTense).toMatchObject({ stage: "construction", retry: true, successes: 0 });
    const wrongMeaning = applyPracticeEvaluation(wrongTense, { ...answer("correct"), meaningPreserved: false });
    expect(wrongMeaning).toMatchObject({ stage: "construction", retry: true, successes: 0 });
    const { tensePreserved, ...unconfirmed } = answer("correct");
    expect(applyPracticeEvaluation(wrongMeaning, unconfirmed)).toMatchObject({ retry: true, successes: 0 });
    expect(applyPracticeEvaluation(wrongMeaning, answer("correct"))).toMatchObject({ stage: "transfer", retry: false, successes: 1 });
  });
  it("teaches English while explaining and correcting in Spanish at every level", () => {
    const context = resolveStudyContext(lesson, ref)!;
    for (const level of ["beginner", "intermediate", "advanced"] as const) {
      const instructions = studyInstructions(context, level, "en", "es");
      expect(instructions).toContain("EXPLANATION LANGUAGE: Spanish");
      expect(instructions).toContain("TEACHING TARGET: English");
      expect(instructions).toContain("from the FIRST turn");
      expect(instructions).toContain("Do not pair a correction with a new exercise");
      expect(instructions).toContain("is not past-tense");
      expect(instructions).not.toContain("Intermediate: mostly target language");
    }
  });
  it("keeps a requested English hint from consuming an attempt or clearing a retry", () => {
    const pending = applyPracticeEvaluation(freshPractice(), answer("incorrect"));
    expect(applyPracticeEvaluation(pending, answer("help"))).toBe(pending);
    expect(isEnglishHintRequest("Give me a brief hint in English")).toBe(true);
    expect(isEnglishHintRequest("Una pista en inglés, por favor")).toBe(true);
    expect(isEnglishHintRequest("Speak slower")).toBe(false);
    const instructions = studyInstructions(resolveStudyContext(lesson, ref)!, "beginner", "en", "es");
    expect(instructions).toContain("DEFAULT EXPLANATION LANGUAGE: Spanish");
    expect(instructions).toContain("ONE brief English hint");
    expect(instructions).toContain("re-ask the SAME pending prompt");
    expect(instructions).toContain("never a permanent switch");
  });
  it("never awards mastery for ambiguous speech or invalid evaluation", () => {
    const p = freshPractice();
    expect(applyPracticeEvaluation(p, answer("ambiguous"))).toBe(p);
    for (const value of [null, {}, answer("unknown"), { ...answer("correct"), prompt: null }]) expect(applyPracticeEvaluation(p, value)).toBe(p);
  });
  it("separates users, sentences and phrases and safely reads corrupt progress", () => {
    expect(practiceStorageKey("tom", ref)).not.toBe(practiceStorageKey("liz", ref));
    expect(practiceStorageKey("tom", ref)).not.toBe(practiceStorageKey("tom", { ...ref, chunkIndex: 0 }));
    expect(parsePracticeProgress({ stage: "transfer", attempts: -1 })).toEqual(freshPractice());
    const p = applyPracticeEvaluation(freshPractice(), answer("incorrect"));
    expect(parsePracticeProgress(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
  it("keeps pronunciation separate and tells the tutor to adapt at every level", () => {
    const context = resolveStudyContext(lesson, ref)!;
    for (const level of ["beginner", "intermediate", "advanced"] as const) {
      const prompt = studyInstructions(context, level, "es", "en");
      expect(prompt).toContain(`${level} level`);
      expect(prompt).toContain("exactly ONE prompt");
      expect(prompt).toContain("smallest meaningful error");
      expect(prompt).toContain("Never invent an Azure score");
      expect(prompt).toContain("reduce after repeated errors");
      expect(prompt).toContain(context.sentence.context_meaning);
    }
  });
});
