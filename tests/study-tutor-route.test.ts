import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { lesson } from "./fixtures/study-tutor";
const mocks = vi.hoisted(() => ({ user: vi.fn(), enabled: vi.fn(), read: vi.fn(), begin: vi.fn(), settle: vi.fn() }));
vi.mock("@/lib/authServer", () => ({ getUserFromRequest: mocks.user }));
vi.mock("@/lib/release", () => ({ tutorEnabled: mocks.enabled }));
vi.mock("@/lib/study/lessonStore", () => ({ readStudyLesson: mocks.read }));
vi.mock("@/lib/tutor/lessonStore", () => ({ readCachedLesson: vi.fn() }));
vi.mock("@/lib/tutor/meter", () => ({ beginTutorSession: mocks.begin, settleTutorSession: mocks.settle, TutorMeterUnavailableError: class extends Error {}, TUTOR_WARN_SECONDS: 120 }));
import { POST } from "@/app/api/tutor/realtime/route";
const body = { target: "es", learner: "en", level: "beginner", study: { lessonKey: "saved-key", sentenceIndex: 0, chunkIndex: 0 } };
function request(value = body) { return new NextRequest("https://taos.test/api/tutor/realtime", { method: "POST", body: JSON.stringify(value) }); }
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "mock-key-not-a-secret");
  mocks.settle.mockResolvedValue(undefined);
  mocks.enabled.mockReturnValue(true);
  mocks.user.mockResolvedValue({ id: "tom", email: "tom@test.invalid" });
  mocks.read.mockResolvedValue({ lesson, target_lang: "es", explain_lang: "en" });
  mocks.begin.mockResolvedValue({ ok: true, sessionId: "session", grantedSeconds: 120, balance: { unlimited: false, remainingSeconds: 60, packSeconds: 0, tier: "free", planSeconds: 900, planLeft: 60 } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: "mock-client-secret" }), { status: 200 })));
});
describe("owned Study practice mint", () => {
  it("retrieves the owned sentence and includes its context, tools and meter", async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith("tom", "saved-key");
    expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({ phase: "partner", target: "es", level: "beginner" }));
    const mint = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).session;
    expect(mint.tool_choice).toBe("required");
    expect(mint.tools[0].name).toBe("evaluate_study_answer");
    expect(mint.instructions).toContain("haya venido");
    expect(mint.instructions).toContain("Reaction to an event");
    expect((await res.json()).studyPhrase).toBe("haya venido");
  });
  it("teaches a prepared English sentence in Spanish independently of account defaults", async () => {
    const englishLesson = { ...lesson, target_language: "en", explain_language: "es", sentences: [{ ...lesson.sentences[0], target: "I'm surprised that he came.", english: "Me sorprende que haya venido.", chunks: ["he came"] }] };
    mocks.read.mockResolvedValue({ lesson: englishLesson, target_lang: "en", explain_lang: "es" });
    const res = await POST(request({ ...body, target: "en", learner: "es" }));
    expect(res.status).toBe(200);
    const mint = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).session;
    expect(mint.instructions).toContain("teaching English to a Spanish speaker");
    expect(mint.instructions).toContain("I'm surprised that he came.");
    expect((await res.json()).studyPhrase).toBe("he came");
  });
  it("refuses missing/other-user lessons and invalid selections before reserving minutes", async () => {
    mocks.read.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(404);
    expect(mocks.begin).not.toHaveBeenCalled();
    mocks.read.mockResolvedValue({ lesson, target_lang: "en", explain_lang: "es" });
    expect((await POST(request())).status).toBe(404);
    expect((await POST(request({ ...body, study: { ...body.study, sentenceIndex: -1 } }))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honors feature flag and sign-in before reading a saved lesson", async () => {
    mocks.enabled.mockReturnValue(false);
    expect((await POST(request())).status).toBe(404);
    mocks.enabled.mockReturnValue(true); mocks.user.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("releases the reservation on a failed mint", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 502 }));
    expect((await POST(request())).status).toBe(502);
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session", serverSeconds: 0, reason: "error" }));
  });
  it("leaves ordinary partner sessions free of study tools", async () => {
    const res = await POST(request({ ...body, study: undefined } as unknown as typeof body));
    expect(res.status).toBe(200);
    const mint = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).session;
    expect(mint.tools).toBeUndefined();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
