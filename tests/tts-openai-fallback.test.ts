import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) =>
    (req.headers.get("authorization") ?? "").startsWith("Bearer ")
      ? { id: "11111111-2222-3333-4444-555555555555", email: "tom@example.com" }
      : null
}));

const insertSpy = vi.fn(async (_row: Record<string, unknown>) => ({ error: null }));
vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: {
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => ({
        abortSignal: (_signal: AbortSignal) => insertSpy(row)
      })
    })
  }
}));

const pending: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => pending.push(promise)
}));

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };

beforeEach(() => {
  pending.length = 0;
  fetchSpy.mockReset();
  insertSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
  process.env.ELEVENLABS_VOICE_ID = "stock-voice";
  process.env.OPENAI_TTS_TIMEOUT_MS = "10";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

const { POST } = await import("@/app/api/tts/route");

function request(): NextRequest {
  return new NextRequest("https://taoslite.com/api/tts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
      "user-agent": "test-agent"
    },
    body: JSON.stringify({
      text: "buenas noches",
      engine: "openai",
      sourceLanguage: "en",
      targetLanguage: "es"
    })
  });
}

function audio(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "Content-Type": "audio/mpeg" }
  });
}

function stalledUntilAborted(init: unknown): Promise<Response> {
  const signal = (init as RequestInit).signal as AbortSignal;
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function writtenRow(): Promise<Record<string, unknown>> {
  await Promise.all(pending);
  expect(insertSpy).toHaveBeenCalledTimes(1);
  return insertSpy.mock.calls[0][0];
}

describe("POST /api/tts — OpenAI leash and stock fallback", () => {
  it("returns ElevenLabs stock audio and logs an OpenAI timeout fallback", async () => {
    fetchSpy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.openai.com")) return stalledUntilAborted(init);
      return Promise.resolve(audio([9, 8, 7]));
    });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(res.headers.get("X-TTS-Engine")).toBe("elevenlabs");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1][0])).toContain("/text-to-speech/stock-voice");
    expect(await writtenRow()).toMatchObject({
      requested_engine: "openai",
      engine: "elevenlabs",
      voice_id: "stock-voice",
      voice_role: "stock",
      status: "ok",
      http_status: 200,
      error_code: "openai_timeout_fallback",
      audio_bytes: 3
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[taos-tts\] status=ok http=200 engine=elevenlabs requested=openai .*voice_role=stock .*err=openai_timeout_fallback/
      )
    );
  });

  it("returns ElevenLabs stock audio and logs an OpenAI 5xx fallback", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(audio([6, 5, 4, 3]));

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(res.headers.get("X-TTS-Engine")).toBe("elevenlabs");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await writtenRow()).toMatchObject({
      requested_engine: "openai",
      engine: "elevenlabs",
      voice_id: "stock-voice",
      voice_role: "stock",
      status: "ok",
      error_code: "openai_503_fallback",
      audio_bytes: 4
    });
  });

  it("leaves a successful OpenAI response unchanged", async () => {
    fetchSpy.mockResolvedValueOnce(audio([1, 2, 3, 4, 5]));

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(res.headers.get("X-TTS-Engine")).toBe("openai");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await writtenRow()).toMatchObject({
      requested_engine: "openai",
      engine: "openai",
      voice_role: "stock",
      status: "ok",
      error_code: null,
      audio_bytes: 5
    });
  });

  it("returns the original 504 and logs the OpenAI timeout when fallback fails", async () => {
    fetchSpy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.openai.com")) return stalledUntilAborted(init);
      return Promise.resolve(new Response("ElevenLabs unavailable", { status: 500 }));
    });

    const res = await POST(request());

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: "The voice service took too long. Please try again."
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await writtenRow()).toMatchObject({
      requested_engine: "openai",
      engine: "elevenlabs",
      voice_id: "stock-voice",
      voice_role: "stock",
      status: "error",
      http_status: 504,
      error_code: "openai_timeout",
      audio_bytes: null
    });
  });
});
