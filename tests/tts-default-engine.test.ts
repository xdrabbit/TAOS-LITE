// The default voice engine is ElevenLabs (Tom, 10/07): Fish Audio was the
// home screen's subscriber default for one day (#85) and "sounded acceptable
// on a computer and bad on the phone". Fish stays selectable for testing.
//
// Two things are pinned:
//   1. The home screen's subscriber default is ElevenLabs, and Fish is only
//      ever reached by a tap on its pill — never chosen on anyone's behalf.
//   2. The cloned-voice path is ElevenLabs: an unlocked phone that names no
//      engine, or names ElevenLabs, hears its clone from ElevenLabs and never
//      from api.fish.audio.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SUBSCRIBER_DEFAULT_ENGINE } from "@/lib/tts/engine";
import { ELEVENLABS_LIZ_VOICE_ENV, ELEVENLABS_TOM_VOICE } from "@/lib/tts/voice";
import { PERSONAL_VOICE_HEADER } from "@/lib/tts/personalVoice";

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) =>
    (req.headers.get("authorization") ?? "").startsWith("Bearer ")
      ? { id: "user-1", email: "tom@example.com" }
      : null
}));

const CODE = "test-personal-voice-code";
const LIZ_ELEVENLABS = "test-liz-elevenlabs-id";

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
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
  process.env.FISHAUDIO_API_KEY = "test-fish-key";
  process.env.FISHAUDIO_TOM_VOICEID = "4aa00a5fa353410d8a53710c5cb9d0b0";
  process.env.FISHAUDIO_LIZ_VOICEID = "a86a2c5bd36e4cd9a9e222b5b5a6261e";
  process.env.TAOS_PERSONAL_VOICE_CODE = CODE;
  process.env[ELEVENLABS_LIZ_VOICE_ENV] = LIZ_ELEVENLABS;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const { POST } = await import("@/app/api/tts/route");

function unlockedRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("https://taoslite.com/api/tts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
      [PERSONAL_VOICE_HEADER]: CODE
    },
    body: JSON.stringify(body)
  });
}

const sentUrl = () => String(fetchSpy.mock.calls[0][0]);

describe("the home screen's default engine", () => {
  const shell = readFileSync(join(process.cwd(), "components/TranslatorShell.tsx"), "utf8");

  it("is ElevenLabs for a subscriber", () => {
    expect(SUBSCRIBER_DEFAULT_ENGINE).toBe("elevenlabs");
    expect(shell).toContain("setEngine(SUBSCRIBER_DEFAULT_ENGINE)");
  });

  it("never picks Fish on anyone's behalf — only a tap on its pill does", () => {
    expect(shell).not.toMatch(/setEngine\(\s*"fishaudio"\s*\)/);
    expect(shell).not.toMatch(/useState<Engine>\(\s*"fishaudio"\s*\)/);
  });

  it("still offers Fish on the picker for testing", () => {
    expect(shell).toMatch(/\["elevenlabs", "fishaudio", "openai"\] as Engine\[\]/);
  });
});

describe("the cloned-voice path is ElevenLabs", () => {
  for (const engine of [undefined, "elevenlabs"]) {
    const label = engine ? `engine: ${engine}` : "no engine named";

    it(`${label}: Tom's line plays his ElevenLabs clone`, async () => {
      const res = await POST(unlockedRequest({ text: "hi", sourceLanguage: "en", targetLanguage: "es", engine }));
      expect(res.status).toBe(200);
      expect(res.headers.get("X-TTS-Engine")).toBe("elevenlabs");
      expect(sentUrl()).toContain("api.elevenlabs.io");
      expect(sentUrl()).toContain(ELEVENLABS_TOM_VOICE);
    });

    it(`${label}: Liz's line plays her ElevenLabs clone, never Fish`, async () => {
      const res = await POST(unlockedRequest({ text: "hola", sourceLanguage: "es", targetLanguage: "en", engine }));
      expect(res.headers.get("X-TTS-Engine")).toBe("elevenlabs");
      expect(sentUrl()).toContain(`/text-to-speech/${LIZ_ELEVENLABS}`);
      for (const [url] of fetchSpy.mock.calls) expect(String(url)).not.toContain("fish.audio");
    });
  }
});
