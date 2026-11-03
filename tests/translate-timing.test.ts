// [taos-translate-timing]: one body-less line per /api/translate request,
// success or error, saying where the seconds went. Diagnostic for the 10/27
// "10-15s from stop-recording to voice" report. The line must never carry the
// transcript or the translation — only lengths, codes and milliseconds.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";

const TRANSCRIPT = "the secret words Liz actually said";
const TRANSLATION = "las palabras secretas que dijo Liz";

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

function chat(content: string, status = 200): Response {
  return new Response(
    status === 200
      ? JSON.stringify({ choices: [{ message: { content } }] })
      : JSON.stringify({ error: { message: "nope" } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function request(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append("audio", new File([new Uint8Array(1234)], "turn.webm", { type: "audio/webm" }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new NextRequest("http://localhost/api/translate", { method: "POST", body: form, headers });
}

const manual = { sourceLanguage: "en", targetLanguage: "es", tone: "casual" };

/** Fresh module = fresh instance, so `cold` starts at 1. */
async function loadRoute() {
  vi.resetModules();
  return import("@/app/api/translate/route");
}

function timingLines(): string[] {
  return logSpy.mock.calls
    .map((c) => c.map(String).join(" "))
    .filter((l) => l.startsWith("[taos-translate-timing]"));
}

function allConsoleOutput(): string {
  return [logSpy, vi.mocked(console.warn), vi.mocked(console.error)]
    .flatMap((s) => s.mock.calls)
    .map((c) => c.map(String).join(" "))
    .join("\n");
}

function field(line: string, key: string): string | undefined {
  return new RegExp(`(?:^| )${key}=(\\S+)`).exec(line)?.[1];
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  guardSpend.mockReset().mockResolvedValue({ ok: true, user: { id: "u1" }, anonymous: false });
  transcribeAudio.mockReset().mockResolvedValue(TRANSCRIPT);
  fetchSpy.mockReset().mockImplementation(async () => chat(TRANSLATION));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

describe("[taos-translate-timing]", () => {
  it("logs exactly one ok line for a manual turn, with every field", async () => {
    const { POST } = await loadRoute();
    const res = await POST(request(manual, { "x-taos-attempt": "1" }));
    expect(res.status).toBe(200);

    const lines = timingLines();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toMatch(
      /^\[taos-translate-timing\] status=ok http=200 mode=manual src=en tgt=es audio_bytes=1234 audio_mime=audio\/webm transcribe_ms=\d+ transcribe_model=gpt-4o-transcribe translate_ms=\d+ translate_model=\S+ guard_ms=\d+ form_ms=\d+ total_ms=\d+ src_chars=\d+ out_chars=\d+ cold=1 retry=0 err=\?$/
    );
    expect(field(line, "src_chars")).toBe(String(TRANSCRIPT.length));
    expect(field(line, "out_chars")).toBe(String(TRANSLATION.length));
  });

  it("logs mode=auto, src=auto and the resolved target on an auto turn", async () => {
    fetchSpy.mockImplementation(async () =>
      chat(JSON.stringify({ source_lang: "en", translation: TRANSLATION }))
    );
    const { POST } = await loadRoute();
    const res = await POST(request({ sourceLanguage: "auto", targetLanguage: "auto", pairA: "en", pairB: "es" }));
    expect(res.status).toBe(200);
    const [line] = timingLines();
    expect(field(line, "status")).toBe("ok");
    expect(field(line, "mode")).toBe("auto");
    expect(field(line, "src")).toBe("auto");
    expect(field(line, "tgt")).toBe("es");
  });

  it("a mixed auto turn: one timing line, the auto transcriber, the first segment's target", async () => {
    process.env.OPENAI_AUTO_TRANSCRIBE_MODEL = "whisper-1";
    try {
      fetchSpy.mockImplementation(async () =>
        chat(
          JSON.stringify({
            segments: [
              { source_lang: "es", original: "uno", translation: "one" },
              { source_lang: "en", original: "two", translation: "dos" }
            ]
          })
        )
      );
      const { POST } = await loadRoute();
      const res = await POST(request({ sourceLanguage: "auto", targetLanguage: "auto", pairA: "en", pairB: "es" }));
      expect(res.status).toBe(200);
      expect((await res.json()).segments).toHaveLength(2);
      const lines = timingLines();
      expect(lines).toHaveLength(1);
      expect(field(lines[0], "status")).toBe("ok");
      expect(field(lines[0], "transcribe_model")).toBe("whisper-1");
      expect(field(lines[0], "tgt")).toBe("en");
      expect(field(lines[0], "out_chars")).toBe(String("one\ndos".length));
    } finally {
      delete process.env.OPENAI_AUTO_TRANSCRIBE_MODEL;
    }
  });

  it("a manual turn reports the default transcriber even when the auto override is set", async () => {
    process.env.OPENAI_AUTO_TRANSCRIBE_MODEL = "whisper-1";
    try {
      const { POST } = await loadRoute();
      await POST(request(manual));
      expect(field(timingLines()[0], "transcribe_model")).toBe("gpt-4o-transcribe");
    } finally {
      delete process.env.OPENAI_AUTO_TRANSCRIBE_MODEL;
    }
  });

  it("cold=1 on the first request of an instance, cold=0 on the second", async () => {
    const { POST } = await loadRoute();
    await POST(request(manual));
    await POST(request(manual));
    const lines = timingLines();
    expect(lines).toHaveLength(2);
    expect(field(lines[0], "cold")).toBe("1");
    expect(field(lines[1], "cold")).toBe("0");
  });

  it("retry=1 when x-taos-attempt is 2, retry=? when the header is absent", async () => {
    const { POST } = await loadRoute();
    await POST(request(manual, { "x-taos-attempt": "2" }));
    await POST(request(manual));
    const lines = timingLines();
    expect(field(lines[0], "retry")).toBe("1");
    expect(field(lines[1], "retry")).toBe("?");
  });

  it("logs one error line with an upstream status code when translation fails", async () => {
    fetchSpy.mockImplementation(async () => chat("", 422));
    const { POST } = await loadRoute();
    const res = await POST(request(manual));
    expect(res.status).toBe(502);
    const lines = timingLines();
    expect(lines).toHaveLength(1);
    expect(field(lines[0], "status")).toBe("error");
    expect(field(lines[0], "http")).toBe("502");
    expect(field(lines[0], "err")).toBe("translate_422");
    expect(field(lines[0], "translate_ms")).toMatch(/^\d+$/);
  });

  it("names a transcription timeout transcribe_timeout", async () => {
    transcribeAudio.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const { POST } = await loadRoute();
    const res = await POST(request(manual));
    expect(res.status).toBe(504);
    const [line] = timingLines();
    expect(field(line, "err")).toBe("transcribe_timeout");
    expect(field(line, "transcribe_ms")).toMatch(/^\d+$/);
    expect(field(line, "translate_ms")).toBe("?");
  });

  it("logs guard_blocked, with guard_ms, when guardSpend refuses", async () => {
    const { NextResponse } = await import("next/server");
    guardSpend.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "sign in" }, { status: 401 })
    });
    const { POST } = await loadRoute();
    const res = await POST(request(manual));
    expect(res.status).toBe(401);
    const [line] = timingLines();
    expect(field(line, "status")).toBe("error");
    expect(field(line, "http")).toBe("401");
    expect(field(line, "err")).toBe("guard_blocked");
    expect(field(line, "guard_ms")).toMatch(/^\d+$/);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("logs nothing_heard on an empty transcript", async () => {
    transcribeAudio.mockResolvedValue("");
    const { POST } = await loadRoute();
    const res = await POST(request(manual));
    expect(res.status).toBe(422);
    expect(field(timingLines()[0], "err")).toBe("nothing_heard");
  });

  it("never writes the transcript or the translation to the console", async () => {
    const { POST } = await loadRoute();
    await POST(request(manual));
    fetchSpy.mockImplementation(async () =>
      chat(JSON.stringify({ source_lang: "en", translation: TRANSLATION }))
    );
    await POST(request({ sourceLanguage: "auto", targetLanguage: "auto" }));
    const out = allConsoleOutput();
    expect(timingLines()).toHaveLength(2);
    expect(out).not.toContain(TRANSCRIPT);
    expect(out).not.toContain(TRANSLATION);
    expect(out).not.toContain("secret");
  });
});
