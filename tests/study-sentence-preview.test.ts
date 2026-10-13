// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lesson } from "./fixtures/study-tutor";
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ getStudyLesson: mocks.get }));
import { StudySentencePreview } from "@/components/tutor/StudySentencePreview";
import { resolveStudyContext, studyContextKey } from "@/lib/tutor/studyPractice";
const englishSentence = { ...lesson.sentences[0], target: "I'm surprised that he came.", english: "Me sorprende que haya venido.", chunks: ["he came", "I'm surprised that he came."] };
const englishLesson = { ...lesson, target_language: "en", explain_language: "es", sentences: [englishSentence] };
const ref = { lessonKey: "english-key", sentenceIndex: 0, contextKey: studyContextKey(englishSentence) };
const props = () => ({ userId: "english-account", selection: ref, target: "en", learner: "es", onLoaded: vi.fn() });
beforeEach(() => { mocks.get.mockResolvedValue({ lesson: englishLesson, target_lang: "en", explain_lang: "es" }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("Study entry before Start", () => {
  it("loads and shows the prepared English sentence and Spanish meaning without minting a session", async () => {
    const p = props(); render(createElement(StudySentencePreview, p));
    expect(await screen.findByText(englishSentence.target)).toBeTruthy();
    expect(screen.getByText(englishSentence.english)).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledWith("english-account", "english-key");
    expect(p.onLoaded).toHaveBeenCalledWith(englishSentence.target);
  });
  it("keeps a selected ladder phrase inside its parent sentence meaning", async () => {
    render(createElement(StudySentencePreview, { ...props(), selection: { ...ref, chunkIndex: 0 } }));
    expect(await screen.findByText("he came")).toBeTruthy();
    expect(screen.getByText(englishSentence.english)).toBeTruthy();
  });
  it("shows missing/changed lessons without declaring the session ready", async () => {
    mocks.get.mockResolvedValue(null);
    const p = props(); render(createElement(StudySentencePreview, p));
    expect((await screen.findByRole("alert")).textContent).toContain("not saved in this account");
    expect(p.onLoaded).not.toHaveBeenCalled();
  });
  it("detects the wrong language pair before a microphone is acquired", async () => {
    const p = { ...props(), target: "es", learner: "en" };
    render(createElement(StudySentencePreview, p));
    expect((await screen.findByRole("alert")).textContent).toContain("language direction changed");
    expect(p.onLoaded).not.toHaveBeenCalled();
  });
  it("accepts the same sentence after JSONB reorders its nested fields", () => {
    const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
    const saved = reorder(englishSentence);
    expect(JSON.stringify(saved)).not.toBe(JSON.stringify(englishSentence));
    expect(studyContextKey(saved)).toBe(ref.contextKey);
    expect(resolveStudyContext({ ...englishLesson, sentences: [saved] }, ref)?.phrase).toBe(englishSentence.target);
    expect(studyContextKey({ ...saved, target: "A different sentence" })).not.toBe(ref.contextKey);
  });
});
