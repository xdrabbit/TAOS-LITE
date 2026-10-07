// Fish Audio (10/06): a second home for Tom's and Liz's clones, selectable on
// the home screen for testing. (It was the subscriber default for one day; the
// default is ElevenLabs again — tests/tts-default-engine.test.ts.)
//
// Three things are pinned:
//   1. Fish obeys the SAME speaker rule as ElevenLabs (tests/tts-voice.test.ts)
//      — both read speakerClone(), so the two engines cannot drift apart.
//   2. The voice variables must hold the model's 32-hex _id. The first setup
//      put the account TITLES ("Tom", "Lizma") in them; a title is treated as
//      unset rather than sent.
//   3. "No Fish clone for this line" hands the line to the ElevenLabs path
//      (stock voice), but a Fish FAILURE is a 502 — never a silent swap to
//      another provider's voice. X-TTS-Engine says who actually spoke.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  FISHAUDIO_LIZ_VOICE_ENV,
  FISHAUDIO_TOM_VOICE_ENV,
  gatedFishAudioVoiceId,
  speakerClone
} from "@/lib/tts/voice";
import { PERSONAL_VOICE_HEADER } from "@/lib/tts/personalVoice";

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) =>
    (req.headers.get("authorization") ?? "").startsWith("Bearer ")
      ? { id: "user-1", email: "tom@example.com" }
      : null
}));

const TOM_FISH = "4aa00a5fa353410d8a53710c5cb9d0b0";
const LIZ_FISH = "a86a2c5bd36e4cd9a9e222b5b5a6261e";
const CODE = "test-personal-voice-code";

const fetchSpy = vi.fn(
  async (_input: unknown, _init?: unknown) =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" }
    })
);
const ORIGINAL_FETCH = globalThis.fetch;
const saved = { ...process.env };

beforeEach(() => {
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.FISHAUDIO_API_KEY = "test-fish-key";
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
  process.env.TAOS_PERSONAL_VOICE_CODE = CODE;
  process.env[FISHAUDIO_TOM_VOICE_ENV] = TOM_FISH;
  process.env[FISHAUDIO_LIZ_VOICE_ENV] = LIZ_FISH;
  delete process.env.FISHAUDIO_MODEL;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const { POST } = await import("@/app/api/tts/route");

function ttsRequest(body: Record<string, unknown>, unlocked = true): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: "Bearer test-token"
  };
  if (unlocked) headers[PERSONAL_VOICE_HEADER] = CODE;
  return new NextRequest("https://taoslite.com/api/tts", {
    method: "POST",
    headers,
    body: JSON.stringify({ engine: "fishaudio", ...body })
  });
}

function sent(): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  return {
    url: String(url),
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body))
  };
}

describe("the speaker rule is shared, not copied", () => {
  it("English speaker -> Tom, Spanish speaker -> Liz, guest or echo -> nobody", () => {
    expect(speakerClone("en", "es")).toBe("tom");
    expect(speakerClone("es", "en")).toBe("liz");
    expect(speakerClone("en", "zh")).toBe("tom");
    expect(speakerClone("zh", "en")).toBeNull();
    expect(speakerClone("en", "en")).toBeNull();
    expect(speakerClone("zh", "en", "liz")).toBe("liz");
  });

  it("Fish resolves the same people to their Fish model ids", () => {
    expect(gatedFishAudioVoiceId(true, "en", "es")).toBe(TOM_FISH);
    expect(gatedFishAudioVoiceId(true, "es", "en")).toBe(LIZ_FISH);
    expect(gatedFishAudioVoiceId(true, "zh", "en")).toBeNull();
  });

  it("a locked phone gets no clone, whatever it asks for", () => {
    expect(gatedFishAudioVoiceId(false, "en", "es")).toBeNull();
    expect(gatedFishAudioVoiceId(false, "es", "en", "liz")).toBeNull();
  });
});

describe("the voice variables hold model ids, not titles", () => {
  it("the account titles from the first setup are refused, not sent", () => {
    process.env[FISHAUDIO_TOM_VOICE_ENV] = "Tom";
    process.env[FISHAUDIO_LIZ_VOICE_ENV] = "Lizma";
    expect(gatedFishAudioVoiceId(true, "en", "es")).toBeNull();
    expect(gatedFishAudioVoiceId(true, "es", "en")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not a Fish Audio model id"));
  });

  it("an unset variable is no clone, said out loud in the log", () => {
    delete process.env[FISHAUDIO_TOM_VOICE_ENV];
    expect(gatedFishAudioVoiceId(true, "en", "es")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(FISHAUDIO_TOM_VOICE_ENV));
  });
});

describe("POST /api/tts with engine: fishaudio", () => {
  it("speaks Tom's English in his Fish clone", async () => {
    const res = await POST(ttsRequest({ text: "dinner at eight", sourceLanguage: "en", targetLanguage: "es" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-TTS-Engine")).toBe("fishaudio");
    const { url, headers, body } = sent();
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(headers.Authorization).toBe("Bearer test-fish-key");
    expect(headers.model).toBe("s2.1-pro");
    expect(body).toMatchObject({ text: "dinner at eight", reference_id: TOM_FISH, format: "mp3" });
  });

  it("speaks Liz's Spanish in her Fish clone", async () => {
    await POST(ttsRequest({ text: "a las ocho", sourceLanguage: "es", targetLanguage: "en" }));
    expect(sent().body.reference_id).toBe(LIZ_FISH);
  });

  it("FISHAUDIO_MODEL swaps the model without a code change", async () => {
    process.env.FISHAUDIO_MODEL = "s1";
    await POST(ttsRequest({ text: "hi", sourceLanguage: "en", targetLanguage: "es" }));
    expect(sent().headers.model).toBe("s1");
  });

  it("a locked phone hears the ElevenLabs stock voice — never a clone", async () => {
    const res = await POST(ttsRequest({ text: "hi", sourceLanguage: "en", targetLanguage: "es" }, false));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-TTS-Engine")).toBe("elevenlabs");
    expect(sent().url).toContain("api.elevenlabs.io");
    expect(sent().url).not.toContain("uOQZaXDzEW5WoyNfLPne"); // Tom's ElevenLabs clone
  });

  it("a guest speaker has no Fish clone and gets the stock voice", async () => {
    const res = await POST(ttsRequest({ text: "你好", sourceLanguage: "zh", targetLanguage: "en" }));
    expect(res.headers.get("X-TTS-Engine")).toBe("elevenlabs");
  });

  it("a Fish failure is a 502, not a quiet swap to another provider", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ status: 402, message: "Insufficient API credit." }), {
          status: 402
        })
    );
    const res = await POST(ttsRequest({ text: "hi", sourceLanguage: "en", targetLanguage: "es" }));
    expect(res.status).toBe(502);
    expect((await res.json()).details).toContain("Insufficient API credit");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("without FISHAUDIO_API_KEY it says so instead of calling anyone", async () => {
    delete process.env.FISHAUDIO_API_KEY;
    const res = await POST(ttsRequest({ text: "hi", sourceLanguage: "en", targetLanguage: "es" }));
    expect(res.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
