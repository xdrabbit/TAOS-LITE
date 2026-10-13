// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { lesson } from "./fixtures/study-tutor";
vi.mock("@/components/study/SayIt", () => ({ SayIt: ({ text }: { text: string }) => createElement("button", null, `Say it: ${text}`) }));
import { StudyLessonCard } from "@/components/study/StudyLessonCard";
import { readPracticeProgress, savePracticeProgress, freshPractice } from "@/lib/tutor/studyPractice";
beforeEach(() => {
  const rows = new Map<string, string>();
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, clear: () => rows.clear() };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); window.localStorage.clear(); vi.unstubAllGlobals(); });
function card() { return render(createElement(StudyLessonCard, { lesson, target: "es", explain: "en", lessonKey: "saved-key", bests: {}, onHear: vi.fn(), onScored: vi.fn() })); }
describe("Study tutor entry", () => {
  it("adds a contextual entry to each sentence/rung while preserving audio, explanation and Say it", () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_TUTOR", "1"); card();
    const links = screen.getAllByRole("link", { name: /Practice with Tutor/ });
    expect(links).toHaveLength(4);
    expect(links[0].getAttribute("href")).toContain("sentence=0");
    expect(links[1].getAttribute("href")).toContain("chunk=0");
    expect(screen.getAllByRole("button", { name: /Hear it:/ })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: /Slowly:/ })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: /Say it:/ })).toHaveLength(4);
    expect(screen.getByText("Reaction to an event", { exact: false })).toBeTruthy();
  });
  it("does not offer a dead tutor link when the feature is disabled", () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_TUTOR", "0"); card();
    expect(screen.queryByRole("link", { name: /Practice with Tutor/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /Say it:/ })).toHaveLength(4);
  });
  it("restores saved progress and tolerates unavailable storage", () => {
    const p = { ...freshPractice(), attempts: 1, retry: true, error: "verb", prompt: "Say it again" };
    savePracticeProgress("key", p); expect(readPracticeProgress("key")).toEqual(p);
    localStorage.setItem("key", "corrupt"); expect(readPracticeProgress("key")).toEqual(freshPractice());
    const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("private mode"); });
    expect(() => savePracticeProgress("key", p)).not.toThrow(); spy.mockRestore();
  });
});
