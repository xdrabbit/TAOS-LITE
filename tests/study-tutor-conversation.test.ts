// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startConversation, type ActiveConversation } from "@/lib/tutor/conversation";
import { freshPractice } from "@/lib/tutor/studyPractice";
let active: ActiveConversation | undefined;
const sent: Array<Record<string, any>> = [];
const channel = { readyState: "open", onopen: null as (() => void) | null, onmessage: null as ((e: { data: string }) => void) | null, send: (data: string) => sent.push(JSON.parse(data)), close: vi.fn() };
function event(value: unknown) { channel.onmessage?.({ data: JSON.stringify(value) }); }
function evaluation(id: string, result: string, stage = "construction") {
  event({ type: "response.done", response: { status: "completed", output: [{ type: "function_call", name: "evaluate_study_answer", call_id: id, arguments: JSON.stringify({ stage, result, meaningPreserved: true, tensePreserved: true, error: "Use haya", prompt: "Say I'm surprised he came" }) }] } });
}
beforeEach(() => {
  sent.length = 0; vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [], getAudioTracks: () => [] }) } });
  vi.stubGlobal("RTCPeerConnection", class {
    addTrack() {} getSenders() { return []; } close() {}
    createDataChannel() { return channel; }
    async createOffer() { return { sdp: "offer" }; }
    async setLocalDescription() {} async setRemoteDescription() {}
  });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => url === "/api/tutor/realtime"
    ? new Response(JSON.stringify({ clientSecret: "mock", callUrl: "https://mock.test/call", instructions: "base persona", studyPhrase: "haya venido" }))
    : new Response("answer")));
});
afterEach(async () => { await active?.stop(); active = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("Study realtime event integration", () => {
  it("passes references and resumed progress, evaluates once, persists retry and only then advances", async () => {
    const onProgress = vi.fn(); const onPhrase = vi.fn();
    active = await startConversation({ target: "es", learner: "en", level: "beginner", phase: "partner", study: { lessonKey: "saved", sentenceIndex: 0 }, studyProgress: freshPractice() }, { onStudyProgress: onProgress, onStudyPhrase: onPhrase });
    const request = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(request.study).toEqual({ lessonKey: "saved", sentenceIndex: 0 });
    expect(onPhrase).toHaveBeenCalledWith("haya venido");
    channel.onopen?.();
    expect(sent.at(-1)?.response.instructions).toContain("selected Study practice");
    active.steer("Please explain in Spanish throughout.");
    expect(sent.at(-1)?.response.instructions).toContain("Live directives from the student");
    event({ type: "input_audio_buffer.speech_started" });
    evaluation("first", "partial");
    expect(onProgress.mock.calls[0][0]).toMatchObject({ retry: true, stage: "construction", successes: 0 });
    expect(sent.at(-1)?.response.instructions).toContain("Require a retry");
    expect(sent.at(-1)?.response.instructions).toContain("Please explain in Spanish throughout.");
    expect(sent.at(-1)?.response.tool_choice).toBe("none");
    active.steer("Give me a hint in English for this retry.");
    expect(sent.at(-1)?.response.instructions).toContain("ONE short clue in the configured EXPLAINED-IN language");
    expect(sent.at(-1)?.response.instructions).toContain("Require a retry");
    expect(onProgress).toHaveBeenCalledTimes(1);
    evaluation("first", "partial"); // duplicate id
    evaluation("extra", "correct"); // second evaluation without a learner turn
    expect(onProgress).toHaveBeenCalledTimes(1);
    event({ type: "input_audio_buffer.speech_started" }); evaluation("retry", "correct");
    expect(sent.at(-1)?.response.instructions).not.toContain("Give me a hint in English for this retry.");
    expect(onProgress.mock.calls[1][0]).toMatchObject({ retry: false, stage: "transfer", successes: 1, attempts: 2 });
    event({ type: "input_audio_buffer.speech_started" }); evaluation("transfer", "incorrect", "transfer");
    expect(onProgress.mock.calls[2][0]).toMatchObject({ retry: true, stage: "transfer", successes: 1 });
  });
  it("handles spoken help without treating it as an answer or clearing a retry", async () => {
    const onProgress = vi.fn();
    const pending = { ...freshPractice(), retry: true, attempts: 1, error: "past tense", prompt: "Say I needed" };
    active = await startConversation({ target: "en", learner: "es", level: "beginner", phase: "partner", study: { lessonKey: "saved", sentenceIndex: 0 }, studyProgress: pending }, { onStudyProgress: onProgress });
    event({ type: "input_audio_buffer.speech_started" });
    evaluation("hint", "help");
    expect(onProgress).not.toHaveBeenCalled();
    expect(sent.at(-1)?.response.instructions).toContain("Give the requested brief hint");
    expect(sent.at(-1)?.response.instructions).toContain("Require a retry");
  });
  it("ignores malformed tool data without awarding progress", async () => {
    const onProgress = vi.fn();
    active = await startConversation({ target: "es", learner: "en", level: "intermediate", phase: "partner", study: { lessonKey: "saved", sentenceIndex: 0 } }, { onStudyProgress: onProgress });
    event({ type: "input_audio_buffer.speech_started" });
    event({ type: "response.done", response: { status: "completed", output: [{ type: "function_call", name: "evaluate_study_answer", call_id: "broken", arguments: "not json" }] } });
    expect(onProgress).not.toHaveBeenCalled();
    expect(sent.find(e => e.item?.type === "function_call_output")?.item.output).toContain('"accepted":false');
  });
});
