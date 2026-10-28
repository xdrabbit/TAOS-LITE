// Home's Auto-detect turns may run on their own transcriber.
//
// PR #108's live check (2026-10-26): production's gpt-4o-transcribe collapses
// a two-language clip into ONE language, so a mixed turn never reaches the
// segments code; gpt-4o-mini-transcribe and whisper-1 keep both halves.
// OPENAI_TRANSCRIBE_MODEL would move every surface's mic, so Tom approved
// (2026-10-27) a narrower knob: OPENAI_AUTO_TRANSCRIBE_MODEL, read by the auto
// path of /api/translate ONLY. Manual-direction turns never see it.
//
// The real transcribeAudio runs here; only guardSpend and fetch are mocked, so
// the assertion is on the `model` field that actually went to OpenAI.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/spendGuard", () => ({
  guardSpend: async () => ({ ok: true, user: { id: "u1", email: "t@example.com" }, anonymous: false })
}));

/** The `model` field of every transcription request, in order. */
let transcribeModels: string[] = [];

const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
  if (String(url).endsWith("/audio/transcriptions")) {
    transcribeModels.push(String((init?.body as FormData).get("model")));
    return Response.json({ text: "Where's the car?" });
  }
  const content = String(init?.body).includes("segments")
    ? JSON.stringify({
        segments: [{ source_lang: "en", original: "Where's the car?", translation: "¿Dónde está el carro?" }]
      })
    : JSON.stringify({ translation: "¿Dónde está el carro?" });
  return Response.json({ choices: [{ message: { content } }] });
});

const { POST } = await import("@/app/api/translate/route");

function turn(source: string, target: string) {
  const form = new FormData();
  form.append("audio", new File([new Uint8Array([1, 2, 3])], "turn.webm", { type: "audio/webm" }));
  form.append("sourceLanguage", source);
  form.append("targetLanguage", target);
  form.append("tone", "casual");
  form.append("pairA", "en");
  form.append("pairB", "es");
  return new Request("http://localhost/api/translate", { method: "POST", body: form }) as never;
}

const ENV_KEYS = ["OPENAI_AUTO_TRANSCRIBE_MODEL", "OPENAI_TRANSCRIBE_MODEL"] as const;

describe("/api/translate transcriber choice", () => {
  let logSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    transcribeModels = [];
    vi.stubGlobal("fetch", fetchSpy);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
    logSpy.mockRestore();
  });

  function translateLog(): string {
    const lines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[taos-translate]"));
    expect(lines).toHaveLength(1);
    return lines[0];
  }

  it("auto, override set: transcribes with OPENAI_AUTO_TRANSCRIBE_MODEL", async () => {
    process.env.OPENAI_AUTO_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
    process.env.OPENAI_TRANSCRIBE_MODEL = "whisper-1";
    const res = await POST(turn("auto", "auto"));
    expect(res.status).toBe(200);
    expect(transcribeModels).toEqual(["gpt-4o-mini-transcribe"]);
    expect(translateLog()).toMatch(/ transcriber=gpt-4o-mini-transcribe ms=\d+$/);
  });

  it("auto, override unset: today's default (gpt-4o-transcribe)", async () => {
    await POST(turn("auto", "auto"));
    expect(transcribeModels).toEqual(["gpt-4o-transcribe"]);
    expect(translateLog()).toMatch(/ transcriber=gpt-4o-transcribe ms=\d+$/);
  });

  it("auto, override unset: still honours OPENAI_TRANSCRIBE_MODEL", async () => {
    process.env.OPENAI_TRANSCRIBE_MODEL = "whisper-1";
    await POST(turn("auto", "auto"));
    expect(transcribeModels).toEqual(["whisper-1"]);
    expect(translateLog()).toContain(" transcriber=whisper-1 ");
  });

  it("auto, override blank: treated as unset", async () => {
    process.env.OPENAI_AUTO_TRANSCRIBE_MODEL = "   ";
    await POST(turn("auto", "auto"));
    expect(transcribeModels).toEqual(["gpt-4o-transcribe"]);
  });

  it("manual direction NEVER uses the override", async () => {
    process.env.OPENAI_AUTO_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
    const res = await POST(turn("en", "es"));
    expect(res.status).toBe(200);
    expect(transcribeModels).toEqual(["gpt-4o-transcribe"]);
    process.env.OPENAI_TRANSCRIBE_MODEL = "whisper-1";
    await POST(turn("es", "en"));
    expect(transcribeModels).toEqual(["gpt-4o-transcribe", "whisper-1"]);
  });

  it("the log line names the transcriber and carries no transcript", async () => {
    process.env.OPENAI_AUTO_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
    await POST(turn("auto", "auto"));
    const line = translateLog();
    expect(line).toMatch(
      /^\[taos-translate\] auto=1 segments=1 detected=en src_chars=\d+ ctx=0 transcriber=gpt-4o-mini-transcribe ms=\d+$/
    );
    expect(line).not.toMatch(/car|carro|example\.com/);
  });
});
