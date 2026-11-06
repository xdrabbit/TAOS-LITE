// Short-transcript retry (2026-11-05): when the transcriber gives up on most
// of a clip, /api/translate runs the same audio ONCE through the fallback
// transcriber, hinted toward the pair's other language, and goes on with the
// retry only when it clearly says more. These pin:
//
//   1. the detector: 0.4 words/s on a clip of 8 s or more, and nothing below
//      8 s or on an empty transcript (lib/translate/shortTranscript.ts)
//   2. the retry runs once and only once — never a third transcription,
//      even when the retry is short too
//   3. the hint: auto mode → the pair's OTHER language from what the first
//      transcript was in, in the API's `language` field; manual → the known
//      source language; whisper gets no prompt
//   4. the 2× rule: a retry that is not clearly longer is dropped
//   5. the timing line carries retry_stt / retry_reason / both word counts,
//      honest latency, and never a word of text
//
// The route runs with only guardSpend and the transcriber mocked (the chat
// completion is a fetch mock by URL), the way tests/translate-timing.test.ts
// does.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";
import {
  RETRY_MIN_WORD_GAIN,
  SHORT_MAX_WORDS_PER_SECOND,
  SHORT_MIN_SECONDS,
  bytesPerSecondFor,
  estimateClipSeconds,
  fallbackTranscribeModel,
  otherPairLanguage,
  pickLongerTranscript,
  retryTranscribeOptions,
  shortTranscriptVerdict,
  wordCount
} from "@/lib/translate/shortTranscript";

const SHORT = "And you know, if I beat you.";
const LONG =
  "Y sabes, si te gano, entonces vamos a tener que hablar de lo que pasó ayer con la cuenta de la casa, " +
  "porque todavía no entiendo por qué cobraron dos veces y nadie me explicó nada en la oficina.";
const TRANSLATION = "las palabras secretas de la traducción";

const guardSpend = vi.fn();
vi.mock("@/lib/spendGuard", () => ({ guardSpend: (...a: unknown[]) => guardSpend(...a) }));

const transcribeAudio = vi.fn();
vi.mock("@/lib/translate/transcribe", () => ({
  transcribeAudio: (...a: unknown[]) => transcribeAudio(...a),
  getTranscribeModel: () => "gpt-4o-transcribe",
  defaultTranscribeModel: () => "gpt-4o-transcribe",
  autoTranscribeModel: () => process.env.OPENAI_AUTO_TRANSCRIBE_MODEL?.trim() || "gpt-4o-transcribe"
}));

const fetchSpy = vi.fn();
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
let logSpy: MockInstance<typeof console.log>;

function chat(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function request(fields: Record<string, string>, bytes = 442943): NextRequest {
  const form = new FormData();
  form.append("audio", new File([new Uint8Array(bytes)], "turn.webm", { type: "audio/webm" }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new NextRequest("http://localhost/api/translate", { method: "POST", body: form });
}

const auto = { sourceLanguage: "auto", targetLanguage: "auto", pairA: "en", pairB: "es", rec_ms: "69000" };
const manual = { sourceLanguage: "es", targetLanguage: "en", tone: "casual", rec_ms: "69000" };

async function loadRoute() {
  vi.resetModules();
  return import("@/app/api/translate/route");
}

function timingLine(): string {
  const lines = logSpy.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.startsWith("[taos-translate-timing]"));
  expect(lines).toHaveLength(1);
  return lines[0];
}

function field(line: string, key: string): string | undefined {
  return new RegExp(`(?:^| )${key}=(\\S+)`).exec(line)?.[1];
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.TAOS_TRANSCRIBE_FALLBACK_MODEL;
  guardSpend.mockReset().mockResolvedValue({ ok: true, user: { id: "u1" }, anonymous: false });
  transcribeAudio.mockReset();
  fetchSpy.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    return body.includes("json_object")
      ? chat(JSON.stringify({ source_lang: "es", translation: TRANSLATION }))
      : chat(TRANSLATION);
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  delete process.env.TAOS_TRANSCRIBE_FALLBACK_MODEL;
  vi.restoreAllMocks();
});

describe("the detector", () => {
  it("pins the numbers: 0.4 words/s on 8 s or more", () => {
    expect(SHORT_MIN_SECONDS).toBe(8);
    expect(SHORT_MAX_WORDS_PER_SECOND).toBe(0.4);
    expect(RETRY_MIN_WORD_GAIN).toBe(2);
  });

  it("the 11/5 clip: 7 words in 69 s is short", () => {
    const v = shortTranscriptVerdict(SHORT, 69);
    expect(v).toMatchObject({ short: true, words: 7, seconds: 69, wps: 0.1 });
  });

  it("conversational speech is not short", () => {
    expect(shortTranscriptVerdict(LONG, 20).short).toBe(false);
    // The slowest honest turn in the census: 0.51 words/s over 55 s.
    expect(shortTranscriptVerdict("a ".repeat(28).trim(), 55).short).toBe(false);
  });

  it("the boundary: 0.4 exactly is not short; just under is", () => {
    expect(shortTranscriptVerdict("one two three four", 10).short).toBe(false); // 0.40
    expect(shortTranscriptVerdict("one two three four", 10.5).short).toBe(true); // 0.38
  });

  it("a phrase under 8 s is never short, and an empty transcript is not a retry (it is a 422)", () => {
    expect(shortTranscriptVerdict("hi", 7.9).short).toBe(false);
    expect(shortTranscriptVerdict("hi", 8).short).toBe(true);
    expect(shortTranscriptVerdict("", 60).short).toBe(false);
    expect(shortTranscriptVerdict("   ", 60).words).toBe(0);
  });

  it("clip length: decoded beats the phone's stopwatch beats the bytes estimate", () => {
    expect(estimateClipSeconds({ recMs: 69000, decodedSeconds: 69.02, bytes: 442943, mime: "audio/webm" })).toBe(69.02);
    expect(estimateClipSeconds({ recMs: 69000, bytes: 442943, mime: "audio/webm" })).toBe(69);
    expect(estimateClipSeconds({ bytes: 442943, mime: "audio/webm;codecs=opus" })).toBeCloseTo(69.2, 1);
    expect(estimateClipSeconds({ recMs: 0, decodedSeconds: null, bytes: 32000 * 3 + 44, mime: "audio/wav" })).toBeCloseTo(3, 1);
    expect(bytesPerSecondFor("audio/mp4")).toBe(8000);
  });

  it("wordCount is whitespace tokens", () => {
    expect(wordCount(" a  b\nc ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});

describe("the pick and the hint", () => {
  it("keeps the retry only when it says at least twice as much", () => {
    expect(pickLongerTranscript(SHORT, LONG).picked).toBe("second");
    expect(pickLongerTranscript("one two three four five six", "one two three four five six seven eight").picked).toBe("first");
    expect(pickLongerTranscript("one two", "one two three four").picked).toBe("second");
    expect(pickLongerTranscript(SHORT, "").picked).toBe("first");
    expect(pickLongerTranscript("", "").picked).toBe("first");
  });

  it("the other language of the pair, from what the first transcript was in", () => {
    expect(otherPairLanguage(SHORT, "en", "es")).toBe("es");
    expect(otherPairLanguage(SHORT, "es", "en")).toBe("es");
    expect(otherPairLanguage("¿Dónde está el carro?", "en", "es")).toBe("en");
    // Only en/es can be told apart; any other pair gets no hint.
    expect(otherPairLanguage(SHORT, "en", "fr")).toBeNull();
    expect(otherPairLanguage(SHORT, "de", "es")).toBeNull();
  });

  it("whisper gets the language field and no prompt; gpt-4o gets both", () => {
    expect(retryTranscribeOptions("whisper-1", { code: "es", label: "Spanish" })).toEqual({
      model: "whisper-1",
      sourceLabel: "Spanish",
      languageCode: "es",
      omitPrompt: true,
      extraHint: undefined
    });
    expect(retryTranscribeOptions("gpt-4o-transcribe", { code: "es", label: "Spanish" }, "hint")).toEqual({
      model: "gpt-4o-transcribe",
      sourceLabel: "Spanish",
      languageCode: "es",
      omitPrompt: undefined,
      extraHint: "hint"
    });
    expect(retryTranscribeOptions("whisper-1", null).languageCode).toBeUndefined();
  });

  it("the fallback model is a knob, whisper-1 by default", () => {
    expect(fallbackTranscribeModel()).toBe("whisper-1");
    process.env.TAOS_TRANSCRIBE_FALLBACK_MODEL = " gpt-transcribe ";
    expect(fallbackTranscribeModel()).toBe("gpt-transcribe");
  });
});

describe("/api/translate retry", () => {
  it("auto: a short first transcript is retried once, hinted toward the pair's other language, and the retry wins", async () => {
    transcribeAudio.mockResolvedValueOnce(SHORT).mockResolvedValueOnce(LONG);
    const { POST } = await loadRoute();
    const res = await POST(request(auto));
    expect(res.status).toBe(200);
    expect((await res.json()).original).toBe(LONG);

    expect(transcribeAudio).toHaveBeenCalledTimes(2);
    const [, , firstOpts] = transcribeAudio.mock.calls[0] as [string, File, Record<string, unknown>];
    expect(firstOpts.languageCode).toBeUndefined();
    expect(firstOpts.omitPrompt).toBeUndefined();
    const [, , retryOpts] = transcribeAudio.mock.calls[1] as [string, File, Record<string, unknown>];
    expect(retryOpts).toMatchObject({ model: "whisper-1", languageCode: "es", sourceLabel: "Spanish", omitPrompt: true });

    const line = timingLine();
    expect(field(line, "retry_stt")).toBe("1");
    expect(field(line, "retry_reason")).toBe("short");
    expect(field(line, "retry_model")).toBe("whisper-1");
    expect(field(line, "retry_hint")).toBe("es");
    expect(field(line, "stt1_words")).toBe("7");
    expect(field(line, "stt2_words")).toBe(String(wordCount(LONG)));
    expect(field(line, "stt_picked")).toBe("retry");
    expect(field(line, "rec_ms")).toBe("69000");
    expect(field(line, "wps")).toBe("0.1");
    expect(field(line, "retry_ms")).toMatch(/^\d+$/);
    expect(field(line, "src_chars")).toBe(String(LONG.length));
  });

  it("manual: the retry keeps the known source language as its hint", async () => {
    transcribeAudio.mockResolvedValueOnce(SHORT).mockResolvedValueOnce(LONG);
    const { POST } = await loadRoute();
    const res = await POST(request(manual));
    expect(res.status).toBe(200);
    expect(transcribeAudio).toHaveBeenCalledTimes(2);
    const [, , retryOpts] = transcribeAudio.mock.calls[1] as [string, File, Record<string, unknown>];
    expect(retryOpts).toMatchObject({ model: "whisper-1", languageCode: "es", sourceLabel: "Spanish" });
    expect(field(timingLine(), "retry_hint")).toBe("es");
  });

  it("once and only once: a retry that is short too does not start a third", async () => {
    transcribeAudio.mockResolvedValueOnce(SHORT).mockResolvedValueOnce("si te gano");
    const { POST } = await loadRoute();
    const res = await POST(request(auto));
    expect(res.status).toBe(200);
    expect(transcribeAudio).toHaveBeenCalledTimes(2);
    // 3 words is not twice 7: the first transcript stands.
    expect((await res.json()).original).toBe(SHORT);
    const line = timingLine();
    expect(field(line, "retry_stt")).toBe("1");
    expect(field(line, "stt_picked")).toBe("first");
    expect(field(line, "stt2_words")).toBe("3");
  });

  it("the 2× rule: a retry only somewhat longer is dropped", async () => {
    transcribeAudio.mockResolvedValueOnce(SHORT).mockResolvedValueOnce("one two three four five six seven eight nine ten eleven twelve thirteen");
    const { POST } = await loadRoute();
    const res = await POST(request(auto));
    expect((await res.json()).original).toBe(SHORT);
    expect(field(timingLine(), "stt_picked")).toBe("first");
  });

  it("no retry on a normal turn, a phrase, or an empty transcript", async () => {
    transcribeAudio.mockResolvedValue(LONG);
    const { POST } = await loadRoute();
    await POST(request(auto));
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    let line = timingLine();
    expect(field(line, "retry_stt")).toBe("0");
    expect(field(line, "retry_reason")).toBe("?");
    expect(field(line, "stt2_words")).toBe("?");

    logSpy.mockClear();
    transcribeAudio.mockReset().mockResolvedValue("just a word");
    await POST(request({ ...auto, rec_ms: "5000" }));
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    line = timingLine();
    expect(field(line, "retry_stt")).toBe("0");
    expect(field(line, "rec_ms")).toBe("5000");

    logSpy.mockClear();
    transcribeAudio.mockReset().mockResolvedValue("");
    const res = await POST(request(auto));
    expect(res.status).toBe(422);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(field(timingLine(), "err")).toBe("nothing_heard");
  });

  it("without rec_ms the clip length is estimated from the bytes", async () => {
    transcribeAudio.mockResolvedValueOnce(SHORT).mockResolvedValueOnce(LONG);
    const { POST } = await loadRoute();
    const { rec_ms: _drop, ...noRec } = auto;
    void _drop;
    await POST(request(noRec, 442943)); // ≈ 69 s of opus
    expect(transcribeAudio).toHaveBeenCalledTimes(2);
    const line = timingLine();
    expect(field(line, "rec_ms")).toBe("?");
    expect(field(line, "retry_stt")).toBe("1");
  });

  it("a failed retry keeps the first transcript and says stt2_words=?", async () => {
    transcribeAudio.mockResolvedValueOnce(SHORT).mockRejectedValueOnce(new Error("upstream"));
    const { POST } = await loadRoute();
    const res = await POST(request(auto));
    expect(res.status).toBe(200);
    expect((await res.json()).original).toBe(SHORT);
    const line = timingLine();
    expect(field(line, "retry_stt")).toBe("1");
    expect(field(line, "stt2_words")).toBe("?");
    expect(field(line, "stt_picked")).toBe("first");
  });

  it("the fallback model knob reaches the retry", async () => {
    process.env.TAOS_TRANSCRIBE_FALLBACK_MODEL = "gpt-4o-transcribe";
    transcribeAudio.mockResolvedValueOnce(SHORT).mockResolvedValueOnce(LONG);
    const { POST } = await loadRoute();
    await POST(request(auto));
    const [, , retryOpts] = transcribeAudio.mock.calls[1] as [string, File, Record<string, unknown>];
    expect(retryOpts).toMatchObject({ model: "gpt-4o-transcribe", languageCode: "es", omitPrompt: undefined });
    expect(field(timingLine(), "retry_model")).toBe("gpt-4o-transcribe");
  });

  it("the timing line is honest about the whole transcription and carries no text", async () => {
    transcribeAudio.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return SHORT;
    });
    transcribeAudio.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return LONG;
    });
    const { POST } = await loadRoute();
    await POST(request(auto));
    const line = timingLine();
    const transcribeMs = Number(field(line, "transcribe_ms"));
    const retryMs = Number(field(line, "retry_ms"));
    expect(retryMs).toBeGreaterThanOrEqual(25);
    expect(transcribeMs).toBeGreaterThanOrEqual(retryMs + 25);
    expect(Number(field(line, "total_ms"))).toBeGreaterThanOrEqual(transcribeMs);
    const out = [logSpy, vi.mocked(console.warn), vi.mocked(console.error)]
      .flatMap((s) => s.mock.calls)
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(out).not.toContain("beat");
    expect(out).not.toContain("gano");
    expect(out).not.toContain(TRANSLATION);
    expect(line).toMatch(/ norm_gain_db=\? norm_ms=\?$/);
  });

  it("the review copy carries rec_ms and the response names the row for Redo", async () => {
    const keep = vi.fn<(...a: unknown[]) => Promise<string>>(async () => "row");
    vi.doMock("@/lib/review/capture", () => ({
      speakerKeepsAudio: async () => true,
      keepTurnForReview: (...a: unknown[]) => keep(...a)
    }));
    const pending: Promise<unknown>[] = [];
    vi.doMock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => void pending.push(p) }));
    guardSpend.mockResolvedValue({ ok: true, user: { id: "u1", email: "founder@example.com" }, anonymous: false });
    transcribeAudio.mockResolvedValue(LONG);
    try {
      const { POST } = await loadRoute();
      const res = await POST(request(manual));
      const body = (await res.json()) as { reviewId?: string };
      expect(body.reviewId).toMatch(/^[0-9a-f-]{36}$/);
      await Promise.all(pending);
      expect(keep).toHaveBeenCalledTimes(1);
      expect(keep.mock.calls[0]?.[0]).toMatchObject({ id: body.reviewId, recMs: 69000, surface: "home" });
    } finally {
      vi.doUnmock("@/lib/review/capture");
      vi.doUnmock("@vercel/functions");
    }
  });
});
