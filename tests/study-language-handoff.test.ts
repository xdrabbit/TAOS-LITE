// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lesson } from "./fixtures/study-tutor";
const mocks = vi.hoisted(() => ({ library: vi.fn(), history: vi.fn(), attempts: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  listStudyLessons: mocks.library, listHistory: mocks.history, listStudyAttempts: mocks.attempts, deleteStudyLesson: vi.fn(),
  supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: "english-account" } } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }) } }
}));
vi.mock("@/components/study/SayIt", () => ({ SayIt: () => null }));
vi.mock("@/components/SignIn", () => ({ SignIn: () => null }));
vi.mock("@/lib/tts/speech", () => ({ requestSpeech: vi.fn() }));
import { StudyShell } from "@/components/StudyShell";
const englishLesson = { ...lesson, target_language: "en", explain_language: "es", sentences: [{ ...lesson.sentences[0], target: "I'm surprised that he came.", english: "Me sorprende que haya venido.", chunks: ["he came", "I'm surprised that he came."] }] };
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ENABLE_TUTOR", "1");
  const stored = new Map([["taos.study.learn", "es"], ["taos.study.explain", "en"]]);
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
  mocks.history.mockResolvedValue([{ id: "source", source_lang: "es", target_lang: "en", original_text: "Me sorprende que haya venido.", translation_text: "I'm surprised that he came.", created_at: "2026-10-12T00:00:00Z", session_id: null }]);
  mocks.library.mockResolvedValue([{ id: "saved", lesson_key: "english-lesson", lesson: englishLesson, target_lang: "en", explain_lang: "es", created_at: "2026-10-12T00:00:00Z" }]);
  mocks.attempts.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
async function openSavedEnglish() {
  render(createElement(StudyShell));
  fireEvent.click(await screen.findByRole("button", { name: "Lessons · Lecciones (1)" }));
  fireEvent.click(screen.getByRole("button", { name: /I'm surprised that he came/ }));
}
describe("saved lesson language handoff", () => {
  it("shows an English lesson explained in Spanish despite the account's opposite default", async () => {
    await openSavedEnglish();
    expect((screen.getByLabelText("Learning · Aprendiendo") as HTMLSelectElement).value).toBe("en");
    expect((screen.getByLabelText("Explained in · Explicado en") as HTMLSelectElement).value).toBe("es");
    const href = screen.getAllByRole("link", { name: /Practice with Tutor/ })[0].getAttribute("href")!;
    expect(new URL(href, "https://taos.test").searchParams.get("target")).toBe("en");
    expect(new URL(href, "https://taos.test").searchParams.get("learner")).toBe("es");
    // Opening a lesson does not rewrite the account/device's preference.
    expect(window.localStorage.getItem("taos.study.learn")).toBe("es");
  });
  it("does not send an old prepared lesson to the tutor after changing direction", async () => {
    await openSavedEnglish();
    fireEvent.change(screen.getByLabelText("Learning · Aprendiendo"), { target: { value: "es" } });
    await waitFor(() => expect(screen.queryByRole("link", { name: /Practice with Tutor/ })).toBeNull());
    expect((screen.getByLabelText("Learning · Aprendiendo") as HTMLSelectElement).value).toBe("es");
    expect((screen.getByLabelText("Explained in · Explicado en") as HTMLSelectElement).value).toBe("en");
  });
});
