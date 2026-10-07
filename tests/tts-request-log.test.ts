// The /api/tts request log (10/07): one record per request saying which
// engine and voice id spoke, whose voice it was, and from what kind of device.
// Built to answer Tom's "Fish sounds like a different voice on my phone".
//
// Pinned here:
//   1. resolveTtsVoice — engine × unlocked × speaker → the provider called,
//      the id sent, and the role. The route speaks from this and the log
//      records it, so they cannot disagree.
//   2. The User-Agent parser, for the devices Tom and Liz actually carry.
//   3. LOGGING NEVER BREAKS TTS: a failing or hanging insert still returns the
//      audio, and the row carries no text, no email, no raw User-Agent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DEFAULT_ELEVENLABS_VOICE,
  ELEVENLABS_LIZ_VOICE_ENV,
  ELEVENLABS_TOM_VOICE,
  FISHAUDIO_LIZ_VOICE_ENV,
  FISHAUDIO_TOM_VOICE_ENV,
  resolveTtsVoice
} from "@/lib/tts/voice";
import { PERSONAL_VOICE_HEADER } from "@/lib/tts/personalVoice";
import {
  parseStandalone,
  parseSurface,
  parseUserAgent,
  ttsLogLine,
  uaHash,
  writeTtsLog,
  type TtsLogRecord
} from "@/lib/tts/requestLog";
import { TTS_STANDALONE_HEADER, TTS_SURFACE_HEADER, ttsDeviceHeaders } from "@/lib/tts/deviceHints";

const TOM_FISH = "4aa00a5fa353410d8a53710c5cb9d0b0";
const LIZ_FISH = "a86a2c5bd36e4cd9a9e222b5b5a6261e";
const LIZ_EL = "lizElevenLabsCloneId0";
const CODE = "test-personal-voice-code";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  iphoneHomeScreen:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
  ipad: "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"
};

// ── What the route's dependencies do in these tests ─────────────────────────

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) =>
    (req.headers.get("authorization") ?? "").startsWith("Bearer ")
      ? { id: "11111111-2222-3333-4444-555555555555", email: "tom@example.com" }
      : null
}));

// The insert, steerable per test.
const insertSpy = vi.fn(async (_row: Record<string, unknown>) => ({ error: null as null | { message: string } }));
vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: {
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => ({
        abortSignal: (_s: AbortSignal) => insertSpy(row)
      })
    })
  }
}));

// waitUntil: collect the background work so a test can await it.
const pending: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p);
  }
}));

const fetchSpy = vi.fn(
  async (_input: unknown, _init?: unknown) =>
    new Response(new Uint8Array([1, 2, 3, 4, 5]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" }
    })
);
const ORIGINAL_FETCH = globalThis.fetch;
const saved = { ...process.env };

beforeEach(() => {
  fetchSpy.mockClear();
  insertSpy.mockReset();
  insertSpy.mockImplementation(async () => ({ error: null }));
  pending.length = 0;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.FISHAUDIO_API_KEY = "test-fish-key";
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TAOS_PERSONAL_VOICE_CODE = CODE;
  process.env[FISHAUDIO_TOM_VOICE_ENV] = TOM_FISH;
  process.env[FISHAUDIO_LIZ_VOICE_ENV] = LIZ_FISH;
  process.env[ELEVENLABS_LIZ_VOICE_ENV] = LIZ_EL;
  delete process.env.ELEVENLABS_VOICE_ID;
  delete process.env.OPENAI_TTS_VOICE;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const { POST } = await import("@/app/api/tts/route");

function ttsRequest(
  body: Record<string, unknown>,
  opts: { unlocked?: boolean; ua?: string; surface?: string; standalone?: string } = {}
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: "Bearer test-token",
    "user-agent": opts.ua ?? UA.iphoneHomeScreen
  };
  if (opts.unlocked ?? true) headers[PERSONAL_VOICE_HEADER] = CODE;
  if (opts.surface) headers[TTS_SURFACE_HEADER] = opts.surface;
  if (opts.standalone) headers[TTS_STANDALONE_HEADER] = opts.standalone;
  return new NextRequest("https://taoslite.com/api/tts", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

// ── 1. The gate, every combination ──────────────────────────────────────────

describe("resolveTtsVoice — engine × unlocked × speaker", () => {
  const cases: [
    engine: "elevenlabs" | "fishaudio" | "openai",
    unlocked: boolean,
    src: "en" | "es" | "zh",
    tgt: "en" | "es",
    expected: { provider: string; voiceId: string; role: string }
  ][] = [
    // ElevenLabs
    ["elevenlabs", true, "en", "es", { provider: "elevenlabs", voiceId: ELEVENLABS_TOM_VOICE, role: "tom" }],
    ["elevenlabs", true, "es", "en", { provider: "elevenlabs", voiceId: LIZ_EL, role: "liz" }],
    ["elevenlabs", true, "zh", "en", { provider: "elevenlabs", voiceId: DEFAULT_ELEVENLABS_VOICE, role: "stock" }],
    ["elevenlabs", false, "en", "es", { provider: "elevenlabs", voiceId: DEFAULT_ELEVENLABS_VOICE, role: "stock" }],
    ["elevenlabs", false, "es", "en", { provider: "elevenlabs", voiceId: DEFAULT_ELEVENLABS_VOICE, role: "stock" }],
    // Fish: a clone when there is one, else the ElevenLabs STOCK voice
    ["fishaudio", true, "en", "es", { provider: "fishaudio", voiceId: TOM_FISH, role: "tom" }],
    ["fishaudio", true, "es", "en", { provider: "fishaudio", voiceId: LIZ_FISH, role: "liz" }],
    ["fishaudio", true, "zh", "en", { provider: "elevenlabs", voiceId: DEFAULT_ELEVENLABS_VOICE, role: "stock" }],
    ["fishaudio", false, "en", "es", { provider: "elevenlabs", voiceId: DEFAULT_ELEVENLABS_VOICE, role: "stock" }],
    ["fishaudio", false, "es", "en", { provider: "elevenlabs", voiceId: DEFAULT_ELEVENLABS_VOICE, role: "stock" }],
    // OpenAI never reaches a clone
    ["openai", true, "en", "es", { provider: "openai", voiceId: "nova", role: "stock" }],
    ["openai", false, "es", "en", { provider: "openai", voiceId: "nova", role: "stock" }]
  ];

  it.each(cases)("%s unlocked=%s %s→%s", (engine, unlocked, src, tgt, expected) => {
    expect(resolveTtsVoice(engine, unlocked, src, tgt)).toEqual(expected);
  });

  it("an explicit tom/liz override is gated like any other request for a clone", () => {
    expect(resolveTtsVoice("fishaudio", false, "zh", "en", "liz").role).toBe("stock");
    expect(resolveTtsVoice("fishaudio", true, "zh", "en", "liz")).toEqual({
      provider: "fishaudio",
      voiceId: LIZ_FISH,
      role: "liz"
    });
  });

  it("an unlocked Tom line with no Fish id goes to Tom's ElevenLabs clone", () => {
    delete process.env[FISHAUDIO_TOM_VOICE_ENV];
    expect(resolveTtsVoice("fishaudio", true, "en", "es")).toEqual({
      provider: "elevenlabs",
      voiceId: ELEVENLABS_TOM_VOICE,
      role: "tom"
    });
  });

  it("a missing Liz ElevenLabs id is reported as the stock voice it really is", () => {
    delete process.env[ELEVENLABS_LIZ_VOICE_ENV];
    expect(resolveTtsVoice("elevenlabs", true, "es", "en")).toEqual({
      provider: "elevenlabs",
      voiceId: DEFAULT_ELEVENLABS_VOICE,
      role: "stock"
    });
  });
});

// ── 2. The User-Agent parser ────────────────────────────────────────────────

describe("parseUserAgent", () => {
  it.each([
    [UA.iphoneSafari, "iPhone", "Safari"],
    [UA.iphoneHomeScreen, "iPhone", "Safari"],
    [UA.iphoneChrome, "iPhone", "Chrome"],
    [UA.ipad, "iPad", "Safari"],
    [UA.macSafari, "Mac", "Safari"],
    [UA.macChrome, "Mac", "Chrome"],
    [UA.androidChrome, "Android", "Chrome"],
    [UA.windowsChrome, "Windows", "Chrome"],
    [UA.windowsEdge, "Windows", "other"],
    [UA.linuxFirefox, "Linux", "Firefox"],
    ["curl/8.5.0", "other", "other"],
    ["", "other", "other"]
  ])("%s", (ua, device, browser) => {
    expect(parseUserAgent(ua)).toEqual({ device, browser });
  });

  it("hashes a UA to 12 hex characters, stable, and different per device", () => {
    expect(uaHash(UA.iphoneSafari)).toMatch(/^[0-9a-f]{12}$/);
    expect(uaHash(UA.iphoneSafari)).toBe(uaHash(UA.iphoneSafari));
    expect(uaHash(UA.iphoneSafari)).not.toBe(uaHash(UA.macSafari));
    expect(uaHash(null)).toBeNull();
  });

  it("reads the client hints narrowly", () => {
    expect(parseSurface("home")).toBe("home");
    expect(parseSurface("Tabletop")).toBe("tabletop");
    expect(parseSurface("admin")).toBe("unknown");
    expect(parseSurface(null)).toBe("unknown");
    expect(parseStandalone("1")).toBe(true);
    expect(parseStandalone("0")).toBe(false);
    expect(parseStandalone("true")).toBe(false);
    expect(parseStandalone(null)).toBe(false);
  });

  it("the client sends standalone=0 and the surface when nothing says otherwise", () => {
    expect(ttsDeviceHeaders("home")).toEqual({
      [TTS_SURFACE_HEADER]: "home",
      [TTS_STANDALONE_HEADER]: "0"
    });
    expect(ttsDeviceHeaders()[TTS_SURFACE_HEADER]).toBe("unknown");
  });
});

// ── 3. The route writes the record, and a failed write never fails TTS ──────

describe("POST /api/tts — the request log", () => {
  it("records engine, voice id, role, device — and never the text", async () => {
    const res = await POST(
      ttsRequest(
        { text: "dinner at eight", engine: "fishaudio", sourceLanguage: "en", targetLanguage: "es" },
        { surface: "home", standalone: "1" }
      )
    );
    expect(res.status).toBe(200);
    await Promise.all(pending);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const row = insertSpy.mock.calls[0][0];
    expect(row).toMatchObject({
      user_id: "11111111-2222-3333-4444-555555555555",
      surface: "home",
      engine: "fishaudio",
      requested_engine: "fishaudio",
      voice_id: TOM_FISH,
      voice_role: "tom",
      unlocked: true,
      lang: "es",
      source_lang: "en",
      text_chars: 15,
      device_family: "iPhone",
      browser: "Safari",
      standalone: true,
      ua_hash: uaHash(UA.iphoneHomeScreen),
      status: "ok",
      http_status: 200,
      error_code: null,
      audio_bytes: 5,
      audio_mime: "audio/mpeg"
    });
    expect(typeof row.latency_ms).toBe("number");
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("dinner");
    expect(serialized).not.toContain("tom@example.com");
    expect(serialized).not.toContain("iPhone OS");
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^\[taos-tts\] status=ok .*voice_id=4aa00a5fa353410d8a53710c5cb9d0b0 voice_role=tom .*device=iPhone browser=Safari standalone=true/));
  });

  it("a locked phone asking for Fish is logged as what it heard: ElevenLabs stock", async () => {
    await POST(
      ttsRequest(
        { text: "hi", engine: "fishaudio", sourceLanguage: "en", targetLanguage: "es" },
        { unlocked: false, surface: "home" }
      )
    );
    await Promise.all(pending);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({
      engine: "elevenlabs",
      requested_engine: "fishaudio",
      voice_id: DEFAULT_ELEVENLABS_VOICE,
      voice_role: "stock",
      unlocked: false
    });
  });

  it("a provider failure is logged as an error with its code", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response("no credit", { status: 402 }));
    const res = await POST(
      ttsRequest({ text: "hi", engine: "fishaudio", sourceLanguage: "en", targetLanguage: "es" })
    );
    expect(res.status).toBe(502);
    await Promise.all(pending);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({
      status: "error",
      http_status: 502,
      error_code: "provider_402",
      voice_id: TOM_FISH,
      audio_bytes: null
    });
  });

  it("a refused stranger is logged too, with no user", async () => {
    const req = new NextRequest("https://taoslite.com/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA.macChrome, origin: "https://taoslite.com" },
      body: JSON.stringify({ text: "hi", engine: "elevenlabs" })
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    await Promise.all(pending);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({
      user_id: null,
      status: "error",
      http_status: 401,
      device_family: "Mac",
      browser: "Chrome"
    });
  });

  it("a request the spend guard refuses gets a log line but no row", async () => {
    const req = new NextRequest("https://taoslite.com/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "curl/8.5.0" },
      body: JSON.stringify({ text: "hi", engine: "openai" })
    });
    const res = await POST(req);
    expect(res.status).toBeGreaterThanOrEqual(400);
    await Promise.all(pending);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^\[taos-tts\] status=error .*err=guard/));
  });

  it("an insert that ERRORS still returns the audio", async () => {
    insertSpy.mockImplementation(async () => ({ error: { message: "relation does not exist" } }));
    const res = await POST(
      ttsRequest({ text: "hi", engine: "elevenlabs", sourceLanguage: "en", targetLanguage: "es" })
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    await Promise.all(pending);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("relation does not exist"));
  });

  it("an insert that THROWS still returns the audio", async () => {
    insertSpy.mockImplementation(async () => {
      throw new Error("network down");
    });
    const res = await POST(
      ttsRequest({ text: "hi", engine: "elevenlabs", sourceLanguage: "en", targetLanguage: "es" })
    );
    expect(res.status).toBe(200);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("network down"));
  });

  it("the route does not wait on the insert", async () => {
    let release: () => void = () => {};
    insertSpy.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ error: null })))
    );
    const res = await POST(
      ttsRequest({ text: "hi", engine: "elevenlabs", sourceLanguage: "en", targetLanguage: "es" })
    );
    expect(res.status).toBe(200); // answered while the insert is still pending
    release();
    await Promise.all(pending);
  });
});

describe("writeTtsLog — gives up on a hung insert and never rejects", () => {
  const record: TtsLogRecord = {
    userId: null,
    surface: "unknown",
    engine: "elevenlabs",
    requestedEngine: "elevenlabs",
    voiceId: DEFAULT_ELEVENLABS_VOICE,
    voiceRole: "stock",
    unlocked: false,
    lang: "es",
    sourceLang: "en",
    textChars: 2,
    device: "Mac",
    browser: "Chrome",
    standalone: false,
    uaHash: null,
    status: "ok",
    httpStatus: 200,
    errorCode: null,
    latencyMs: 10,
    audioBytes: 3,
    audioMime: "audio/mpeg"
  };

  it("times out a hung insert and aborts it", async () => {
    let aborted = false;
    await expect(
      writeTtsLog(
        record,
        (_row, signal) =>
          new Promise(() => {
            signal.addEventListener("abort", () => (aborted = true));
          }),
        20
      )
    ).resolves.toBeUndefined();
    expect(aborted).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("the log line cannot be forged into a second line", () => {
    const line = ttsLogLine({ ...record, voiceId: "abc\n[taos-tts] status=ok fake=1" });
    expect(line).not.toContain("\n");
    expect(line.match(/\[taos-tts\]/g)).toHaveLength(1);
  });
});
