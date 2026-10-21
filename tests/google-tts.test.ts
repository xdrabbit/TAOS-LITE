import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  GOOGLE_TTS_TIMEOUT_MS,
  googleChirp3Voice,
  googleTtsTier,
  googleVoiceFor
} from "@/lib/tts/google";

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async () => ({ id: "founder-1", email: "xdrabbit@gmail.com" })
}));

const pending: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => pending.push(promise)
}));

const insertSpy = vi.fn(async (_row: Record<string, unknown>) => ({
  error: null as null | { message: string }
}));
vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: {
    from: () => ({
      insert: (row: Record<string, unknown>) => ({ abortSignal: () => insertSpy(row) })
    })
  }
}));

const fetchSpy = vi.fn(async (input: string | URL | Request) => {
  if (String(input).includes("texttospeech.googleapis.com")) {
    return Response.json({ audioContent: Buffer.from([7, 8, 9]).toString("base64") });
  }
  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
});

const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };

beforeEach(() => {
  fetchSpy.mockClear();
  insertSpy.mockClear();
  pending.length = 0;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
  process.env.ELEVENLABS_VOICE_ID = "test-stock-voice";
  process.env.GOOGLE_TTS_API_KEY = "test-google-key";
  process.env.TAOS_TTS_GOOGLE_ENABLED = "1";
  delete process.env.GOOGLE_TTS_TIER;
  delete process.env.GOOGLE_TTS_CHIRP3_VOICE;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

const { POST } = await import("@/app/api/tts/route");

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("https://taoslite.com/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ engine: "google", ...body })
  });
}

function sent(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [input, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
  return { url: String(input), init, body: JSON.parse(String(init.body)) };
}

describe("Google Cloud TTS voice selection", () => {
  it("defaults to Chirp 3 and accepts only the four named tiers", () => {
    expect(googleTtsTier()).toBe("chirp3");
    expect(googleTtsTier(" standard ")).toBe("standard");
    expect(googleTtsTier("WAVENET")).toBe("wavenet");
    expect(googleTtsTier("NEURAL2")).toBe("neural2");
    expect(googleTtsTier("CHIRP3")).toBe("chirp3");
    expect(googleTtsTier("studio")).toBe("chirp3");
  });

  it("uses Kore for verified English and Spanish Chirp 3 locales", () => {
    expect(googleVoiceFor("en")).toEqual({
      languageCode: "en-US",
      voiceName: "en-US-Chirp3-HD-Kore"
    });
    expect(googleVoiceFor("es")).toEqual({
      languageCode: "es-US",
      voiceName: "es-US-Chirp3-HD-Kore"
    });
  });

  it("reads the shared Chirp 3 voice name from the environment", () => {
    process.env.GOOGLE_TTS_CHIRP3_VOICE = " Aoede ";
    expect(googleChirp3Voice()).toBe("Aoede");
    expect(googleVoiceFor("es")).toEqual({
      languageCode: "es-US",
      voiceName: "es-US-Chirp3-HD-Aoede"
    });
  });

  it("falls back through the existing Neural2 entry where Chirp 3 is unavailable", () => {
    expect(googleVoiceFor("tl")).toEqual({
      languageCode: "fil-PH",
      voiceName: "fil-ph-Neural2-A"
    });
    expect(googleVoiceFor("ms")).toEqual({
      languageCode: "ms-MY",
      voiceName: "ms-MY-Wavenet-A"
    });
    expect(googleVoiceFor("yue", "neural2")).toEqual({
      languageCode: "yue-HK",
      voiceName: "yue-HK-Standard-A"
    });
    expect(googleVoiceFor("bs", "wavenet")).toBeNull();
  });
});

describe("POST /api/tts with engine: google", () => {
  it("treats Google as an unknown engine while the flag is off", async () => {
    delete process.env.TAOS_TTS_GOOGLE_ENABLED;
    const res = await POST(request({ text: "hola", targetLanguage: "es" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-TTS-Engine")).toBe("elevenlabs");
    expect(sent().url).toContain("api.elevenlabs.io");
  });

  it("sends the selected language, voice name, and MP3 encoding", async () => {
    const res = await POST(request({ text: "buenas noches", targetLanguage: "es" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("X-TTS-Engine")).toBe("google");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));

    const { url, init, body } = sent();
    expect(url).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect(init.headers).toMatchObject({ "x-goog-api-key": "test-google-key" });
    expect(body).toEqual({
      input: { text: "buenas noches" },
      voice: { languageCode: "es-US", name: "es-US-Chirp3-HD-Kore" },
      audioConfig: { audioEncoding: "MP3" }
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(GOOGLE_TTS_TIMEOUT_MS).toBe(8000);

    await Promise.all(pending);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({
      engine: "google",
      requested_engine: "google",
      voice_id: "es-US-Chirp3-HD-Kore",
      voice_role: "stock"
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[taos-tts\].*engine=google.*voice_id=es-US-Chirp3-HD-Kore voice_role=stock/
      )
    );
  });

  it("uses the existing can't-speak response for an unsupported Google language", async () => {
    const res = await POST(request({ text: "dobro jutro", targetLanguage: "bs" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ textOnly: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to ElevenLabs stock when Google fails", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response("upstream unavailable", { status: 503 }));
    const res = await POST(request({ text: "hello", targetLanguage: "en" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-TTS-Engine")).toBe("elevenlabs");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1][0])).toContain("/text-to-speech/test-stock-voice");
    await Promise.all(pending);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({
      engine: "elevenlabs",
      requested_engine: "google",
      voice_id: "test-stock-voice",
      voice_role: "stock",
      status: "ok",
      error_code: "google_503_fallback"
    });
  });

  it("returns the original Google error when the stock fallback also fails", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("Google unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("ElevenLabs unavailable", { status: 500 }));
    const res = await POST(request({ text: "hello", targetLanguage: "en" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "Google Cloud TTS failed." });
    await Promise.all(pending);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({
      engine: "elevenlabs",
      requested_engine: "google",
      voice_id: "test-stock-voice",
      voice_role: "stock",
      status: "error",
      error_code: "provider_503"
    });
  });
});
