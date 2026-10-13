// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lesson } from "./fixtures/study-tutor";
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ listStudyLessons: mocks.list }));
import { PreparedStudyPicker } from "@/components/tutor/PreparedStudyPicker";
import { resolveStudyContext, studyContextKey } from "@/lib/tutor/studyPractice";
const englishLesson = { ...lesson, target_language: "en", explain_language: "es", sentences: [{ ...lesson.sentences[0], target: "I'm surprised that he came.", english: "Me sorprende que haya venido.", chunks: ["he came", "I'm surprised that he came."] }] };
beforeEach(() => {
  mocks.list.mockResolvedValue([
    { lesson_key: "spanish", target_lang: "es", explain_lang: "en", lesson },
    { lesson_key: "english", target_lang: "en", explain_lang: "es", lesson: englishLesson }
  ]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("prepared sentences in Partner", () => {
  it("offers English explained in Spanish and carries the exact prepared context", async () => {
    const onSelect = vi.fn();
    render(createElement(PreparedStudyPicker, { target: "en", learner: "es", onSelect }));
    await screen.findByRole("option", { name: "I'm surprised that he came." });
    expect(screen.queryByRole("option", { name: lesson.sentences[0].target })).toBeNull();
    fireEvent.change(screen.getByLabelText("Prepared Study sentence"), { target: { value: "0" } });
    const ref = onSelect.mock.calls[0][0];
    expect(ref).toEqual({ lessonKey: "english", sentenceIndex: 0, contextKey: studyContextKey(englishLesson.sentences[0]) });
    expect(resolveStudyContext(englishLesson, ref)?.phrase).toBe("I'm surprised that he came.");
    fireEvent.change(screen.getByLabelText("Prepared Study sentence"), { target: { value: "" } });
    expect(onSelect).toHaveBeenLastCalledWith(undefined, "");
  });
  it("updates available prepared sentences when the practice direction flips", async () => {
    const props = { target: "es", learner: "en", onSelect: vi.fn() };
    const view = render(createElement(PreparedStudyPicker, props));
    await screen.findByRole("option", { name: lesson.sentences[0].target });
    view.rerender(createElement(PreparedStudyPicker, { ...props, target: "en", learner: "es" }));
    expect(screen.getByRole("option", { name: "I'm surprised that he came." })).toBeTruthy();
    expect(screen.queryByRole("option", { name: lesson.sentences[0].target })).toBeNull();
  });
  it("directs a learner to Study if no lesson is prepared in that direction", async () => {
    render(createElement(PreparedStudyPicker, { target: "it", learner: "en", onSelect: vi.fn() }));
    expect(await screen.findByRole("link", { name: "Prepare one in Study" })).toBeTruthy();
  });
  it("shows retrieval failures while keeping free conversation available", async () => {
    mocks.list.mockRejectedValue(new Error("offline"));
    render(createElement(PreparedStudyPicker, { target: "en", learner: "es", onSelect: vi.fn() }));
    await screen.findByRole("alert");
    await waitFor(() => expect((screen.getByLabelText("Prepared Study sentence") as HTMLSelectElement).disabled).toBe(true));
  });
});
