// The Gemini arm of the /call bake-off (Tom, 2026-09-28), everything that
// can be pinned without a phone: who may mint, what the session is told, what
// it costs, the PCM plumbing, and the jitter buffer's policy.
//
// The engine itself, driven through a fake socket, is tests/call-gemini-engine.test.ts.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  addGeminiTurn,
  addGeminiUsage,
  costLogLine,
  emptySpend,
  GEMINI_RATES_USD_PER_MTOK,
  spendUsd,
  usdPerMinute
} from "@/lib/call/cost";
import {
  buildGeminiSetup,
  GEMINI_LIVE_TRANSLATE_MODEL,
  geminiLanguageCode,
  geminiSystemInstruction
} from "@/lib/call/geminiSession";
import { MEANING_FIRST_RULE } from "@/lib/translate/prompts";
import {
  base64ToBytes,
  bytesToBase64,
  createPcmDownsampler,
  floatToS16,
  PCM_IN_CHUNK_SAMPLES,
  s16ToLeBytes,
  s16leBytesToFloat
} from "@/lib/call/pcm";
import {
  decideSchedule,
  MAX_AHEAD_S,
  PREROLL_S,
  TARGET_AHEAD_S
} from "@/lib/call/pcmPlayer";
import { lagLogLine, sanitizeLagRecord, type LagRecord } from "@/lib/call/lag";
import { parseInterpreterEngine } from "@/lib/call/interpreterEngine";

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

// Stands in for Google. If this is called for a non-founder, the gate leaks.
const fetchSpy = vi.fn(
  async (..._args: unknown[]) =>
    new Response(JSON.stringify({ name: "auth_tokens/test-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
);

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_ENABLE_CALL;
const FOUNDER = { id: "u2", email: "xdrabbit@gmail.com" };
const CUSTOMER = { id: "u1", email: "customer@example.com" };

beforeEach(() => {
  caller = null;
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.GEMINI_API_KEY = "AIza-test-key";
  delete process.env.NEXT_PUBLIC_ENABLE_CALL;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_FLAG === undefined) delete process.env.NEXT_PUBLIC_ENABLE_CALL;
  else process.env.NEXT_PUBLIC_ENABLE_CALL = ORIGINAL_FLAG;
  vi.resetModules();
});

function mintRequest(body: Record<string, unknown>, token?: string): NextRequest {
  return new NextRequest("https://taoslite.com/api/call/gemini", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

async function mintRoute() {
  return (await import("@/app/api/call/gemini/route")).POST;
}

describe("POST /api/call/gemini — founders only, even if /call ships", () => {
  it("404s a signed-out stranger without calling Google", async () => {
    const res = await (await mintRoute())(mintRequest({ source: "es", target: "en" }));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s a signed-in customer without calling Google", async () => {
    caller = CUSTOMER;
    const res = await (await mintRoute())(mintRequest({ source: "es", target: "en" }, "tok"));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still 404s a customer when NEXT_PUBLIC_ENABLE_CALL ships /call to everyone", async () => {
    // The engine choice is an evaluation, not a product. The public flag is
    // Tom's ceremony for /call itself and must not open this.
    process.env.NEXT_PUBLIC_ENABLE_CALL = "1";
    caller = CUSTOMER;
    const res = await (await mintRoute())(mintRequest({ source: "es", target: "en" }, "tok"));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("500s, naming the variable, when GEMINI_API_KEY is missing", async () => {
    delete process.env.GEMINI_API_KEY;
    caller = FOUNDER;
    const res = await (await mintRoute())(mintRequest({ source: "es", target: "en" }, "tok"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).toContain("GEMINI_API_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mints a one-use token with the whole setup locked inside it", async () => {
    caller = FOUNDER;
    const res = await (await mintRoute())(mintRequest({ source: "es", target: "en" }, "tok"));
    expect(res.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1alpha/auth_tokens");
    const sent = JSON.parse(String(init.body));
    expect(sent.uses).toBe(1);
    expect(sent.bidiGenerateContentSetup).toEqual(buildGeminiSetup("en"));

    // The browser gets a Constrained-endpoint URL and the token — never the key.
    const body = await res.json();
    expect(body.wsUrl).toContain("BidiGenerateContentConstrained?access_token=");
    expect(body.model).toBe(GEMINI_LIVE_TRANSLATE_MODEL);
    expect(JSON.stringify(body)).not.toContain("AIza-test-key");
  });

  it("never lets an unknown language code reach the token", async () => {
    caller = FOUNDER;
    await (await mintRoute())(mintRequest({ source: "es", target: "xx; drop" }, "tok"));
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent.bidiGenerateContentSetup.generationConfig.translationConfig.targetLanguageCode).toBe(
      "en"
    );
  });

  it("does not echo the key when Google's call throws", async () => {
    caller = FOUNDER;
    fetchSpy.mockImplementationOnce(async () => {
      throw new Error("connect failed for ...?key=AIza-test-key");
    });
    const res = await (await mintRoute())(mintRequest({ source: "es", target: "en" }, "tok"));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("AIza-test-key");
  });
});

describe("the session Gemini is given", () => {
  it("pins the preview model string in one constant", () => {
    // A PREVIEW model: Google can change it under us. Changing this string is
    // a new bake-off, not a refactor.
    expect(GEMINI_LIVE_TRANSLATE_MODEL).toBe("gemini-3.5-live-translate-preview");
    expect(buildGeminiSetup("en").model).toBe("models/gemini-3.5-live-translate-preview");
  });

  it("is told MEANING_FIRST_RULE verbatim — tú by default — and nothing else", () => {
    // Measured 2026-09-28: without it, neutral English came back in usted 3/3
    // (Liz's #65 complaint); with exactly this text, tú 3/3. No other rule
    // was probed against this model, so no other rule is sent.
    expect(geminiSystemInstruction()).toBe(MEANING_FIRST_RULE());
    expect(geminiSystemInstruction()).toContain("tú");
    const setup = buildGeminiSetup("es") as {
      systemInstruction: { parts: Array<{ text: string }> };
    };
    expect(setup.systemInstruction.parts).toEqual([{ text: MEANING_FIRST_RULE() }]);
  });

  it("puts the transcription switches on setup, where the server accepts them", () => {
    // Google's raw-WebSocket example nests them in generationConfig, and that
    // is rejected with 1007 "Cannot find field". Measured.
    const setup = buildGeminiSetup("en") as Record<string, Record<string, unknown>>;
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    expect(setup.generationConfig.inputAudioTranscription).toBeUndefined();
  });

  it("stays silent on speech already in the listener's language", () => {
    const setup = buildGeminiSetup("en") as {
      generationConfig: { translationConfig: Record<string, unknown> };
    };
    expect(setup.generationConfig.translationConfig).toEqual({
      targetLanguageCode: "en",
      echoTargetLanguage: false
    });
  });

  it("maps the catalog codes Google spells differently, and passes the rest through", () => {
    expect(geminiLanguageCode("zh")).toBe("zh-Hans");
    expect(geminiLanguageCode("tl")).toBe("fil");
    expect(geminiLanguageCode("es")).toBe("es");
    // Not on Google's list; accepted as a target when measured. Passed
    // through so a founder can try it — not a promise that it is any good.
    expect(geminiLanguageCode("sm")).toBe("sm");
  });

  it("defaults the engine to OpenAI for anything that is not exactly gemini", () => {
    expect(parseInterpreterEngine("gemini")).toBe("gemini");
    expect(parseInterpreterEngine("openai")).toBe("openai");
    expect(parseInterpreterEngine(undefined)).toBe("openai");
    expect(parseInterpreterEngine("GEMINI")).toBe("openai");
  });
});

describe("what a Gemini minute costs", () => {
  it("prices at the brief's rates: $3.50/M in, $21/M out", () => {
    expect(GEMINI_RATES_USD_PER_MTOK).toEqual({ audioIn: 3.5, audioOut: 21 });
  });

  it("sums usageMetadata as deltas, the way the server sends them", () => {
    // Measured: one message every ~2s, each 50/50 — a delta, not a total.
    let spend = emptySpend("none", "gemini");
    for (let i = 0; i < 29; i++) {
      spend = addGeminiUsage(spend, { promptTokenCount: 50, responseTokenCount: 50 });
    }
    expect(spend.audioInTokens).toBe(1450);
    expect(spend.audioOutTokens).toBe(1450);
    // The 2026-09-28 silence run: 60s of nothing, still billed both ways.
    expect(spendUsd(spend)).toBeCloseTo((1450 * 3.5 + 1450 * 21) / 1e6, 10);
  });

  it("ignores junk in a usage payload", () => {
    const spend = addGeminiUsage(emptySpend("none", "gemini"), {
      promptTokenCount: "50",
      responseTokenCount: -3
    });
    expect(spend.audioInTokens).toBe(0);
    expect(spend.audioOutTokens).toBe(0);
    expect(addGeminiUsage(spend, null)).toBe(spend);
  });

  it("comes to ~3.68¢ per minute of call, silence included — the number to put beside 3.88¢", () => {
    let spend = emptySpend("none", "gemini");
    spend = addGeminiUsage(spend, { promptTokenCount: 1500, responseTokenCount: 1500 });
    expect(usdPerMinute(spend, 60)).toBeCloseTo(0.03675, 6);
  });

  it("does not let the same token counts price at OpenAI's rates, or vice versa", () => {
    const tokens = { audioInTokens: 1500, audioOutTokens: 1500 };
    const gemini = { ...emptySpend("none", "gemini"), ...tokens };
    const openai = { ...emptySpend("elevenlabs", "openai"), ...tokens };
    expect(spendUsd(gemini)).toBeCloseTo(0.03675, 6);
    expect(spendUsd(openai)).toBeCloseTo((1500 * 32 + 1500 * 64) / 1e6, 6);
  });

  it("puts engine= on the cost line, for both arms", () => {
    const g = costLogLine({
      room: "AB123",
      mode: "native",
      direction: "es->en",
      seconds: 60,
      spend: addGeminiTurn(
        addGeminiUsage(emptySpend("none", "gemini"), {
          promptTokenCount: 1500,
          responseTokenCount: 1500
        })
      )
    });
    expect(g).toContain("engine=gemini");
    expect(g).toContain("mode=native");
    expect(g).toContain("tts=none");
    expect(g).toContain("responses=1");
    expect(g).toContain("audio_in_tok=1500");
    expect(g).toContain("audio_out_tok=1500");
    expect(g).toContain("usd_per_min=0.0367");

    const o = costLogLine({
      room: "AB123",
      mode: "clone",
      direction: "es->en",
      seconds: 60,
      spend: emptySpend()
    });
    expect(o).toContain("engine=openai");
  });
});

describe("POST /api/call/usage takes the Gemini arm", () => {
  it("writes engine=gemini and prices it at Gemini's rates", async () => {
    caller = FOUNDER;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const POST = (await import("@/app/api/call/usage/route")).POST;
    const res = await POST(
      new NextRequest("https://taoslite.com/api/call/usage", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
        body: JSON.stringify({
          room: "AB123",
          mode: "native",
          engine: "gemini",
          direction: "es->en",
          seconds: 60,
          spend: { responses: 0, audioInTokens: 1500, audioOutTokens: 1500, ttsEngine: "none" },
          captions: 0,
          speechStarted: 0
        })
      })
    );
    expect(res.status).toBe(204);
    const line = info.mock.calls[0]?.[0] as string;
    expect(line).toContain("engine=gemini");
    expect(line).toContain("mode=native");
    expect(line).toContain("tts=none");
    // A session that translated nothing still has a line, with its dollars.
    expect(line).toContain("responses=0");
    expect(line).toContain("usd=0.0367");
    info.mockRestore();
  });

  it("treats a report with no engine as OpenAI, like every build before this one", async () => {
    caller = FOUNDER;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const POST = (await import("@/app/api/call/usage/route")).POST;
    await POST(
      new NextRequest("https://taoslite.com/api/call/usage", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
        body: JSON.stringify({ room: "AB123", mode: "clone", seconds: 60, spend: {} })
      })
    );
    expect(info.mock.calls[0]?.[0]).toContain("engine=openai");
    info.mockRestore();
  });
});

describe("[taos-call-lag] says which engine it measured", () => {
  const record: LagRecord = {
    kind: "turn",
    pair: "es->en",
    engine: "gemini",
    values: { session: 1, turn: 1, wait_ms: -1200, generation_ms: 900 }
  };

  it("prints engine= right after the pair", () => {
    expect(lagLogLine(record, "AB123")).toContain("pair=es->en engine=gemini session=1");
  });

  it("keeps a negative wait_ms — Gemini translates before the speaker stops", () => {
    expect(lagLogLine(record, "AB123")).toContain("wait_ms=-1200");
  });

  it("accepts only a known engine from a phone", () => {
    expect(sanitizeLagRecord({ ...record })?.engine).toBe("gemini");
    expect(sanitizeLagRecord({ ...record, engine: "claude" })?.engine).toBe("openai");
    expect(sanitizeLagRecord({ ...record, engine: undefined })?.engine).toBe("openai");
  });
});

describe("PCM in: 16 kHz, 100 ms, from whatever rate the context runs at", () => {
  function collect(inRate: number, blocks: Float32Array[]): Int16Array[] {
    const out: Int16Array[] = [];
    const d = createPcmDownsampler(inRate, (c) => out.push(c));
    for (const b of blocks) d.push(b);
    return out;
  }

  it("turns one second at 48 kHz into exactly ten 100 ms chunks", () => {
    const chunks = collect(48_000, [new Float32Array(48_000).fill(0.5)]);
    expect(chunks).toHaveLength(10);
    expect(chunks.every((c) => c.length === PCM_IN_CHUNK_SAMPLES)).toBe(true);
    expect(chunks[3][700]).toBe(floatToS16(0.5));
  });

  it("does not drift at 44.1 kHz over ten minutes of odd-sized blocks", () => {
    // A resampler that loses a fraction of a sample per block walks the
    // session's audio clock away from wall time — the thing audio_arrival_ms
    // is watching for. 600 s must be 6000 chunks, give or take the one
    // still filling.
    const out: Int16Array[] = [];
    const d = createPcmDownsampler(44_100, (c) => out.push(c));
    const block = new Float32Array(2048);
    let fed = 0;
    while (fed < 44_100 * 600) {
      const n = Math.min(block.length, 44_100 * 600 - fed);
      d.push(block.subarray(0, n));
      fed += n;
    }
    expect(out.length).toBeGreaterThanOrEqual(5999);
    expect(out.length).toBeLessThanOrEqual(6000);
  });

  it("clamps rather than wrapping past full scale", () => {
    expect(floatToS16(2)).toBe(32767);
    expect(floatToS16(-2)).toBe(-32768);
    expect(floatToS16(0)).toBe(0);
  });

  it("sends little-endian, and reads it back", () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const bytes = s16ToLeBytes(samples);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0, 0, 1, 0]);
    const back = s16leBytesToFloat(bytes);
    expect(Math.round(back[3] * 0x8000)).toBe(32767);
    expect(back[4]).toBe(-1);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe("the jitter buffer: drop, never queue", () => {
  it("starts a stream PREROLL_S out", () => {
    expect(decideSchedule({ now: 10, nextTime: null, voiced: true, muted: false })).toEqual({
      action: "play",
      at: 10 + PREROLL_S,
      underrun: false
    });
  });

  it("plays back to back while the stream keeps up", () => {
    expect(decideSchedule({ now: 10, nextTime: 10.2, voiced: true, muted: false })).toEqual({
      action: "play",
      at: 10.2,
      underrun: false
    });
  });

  it("re-primes after an underrun instead of squeezing the audio", () => {
    expect(decideSchedule({ now: 10, nextTime: 9.5, voiced: true, muted: false })).toEqual({
      action: "play",
      at: 10 + PREROLL_S,
      underrun: true
    });
  });

  it("catches up by dropping SILENCE once past the target", () => {
    const ahead = TARGET_AHEAD_S + 0.1;
    expect(decideSchedule({ now: 10, nextTime: 10 + ahead, voiced: false, muted: false })).toEqual({
      action: "drop",
      reason: "silence"
    });
    // ...but never speech, until the hard ceiling.
    expect(decideSchedule({ now: 10, nextTime: 10 + ahead, voiced: true, muted: false }).action).toBe(
      "play"
    );
  });

  it("drops speech too past MAX_AHEAD_S — the backlog has a ceiling", () => {
    expect(
      decideSchedule({ now: 10, nextTime: 10 + MAX_AHEAD_S + 0.01, voiced: true, muted: false })
    ).toEqual({ action: "drop", reason: "overrun" });
  });

  it("schedules nothing while muted", () => {
    expect(decideSchedule({ now: 10, nextTime: 10.2, voiced: true, muted: true })).toEqual({
      action: "drop",
      reason: "muted"
    });
  });

  it("stays bounded over an hour when the server outruns the local clock", () => {
    // Gemini streams output continuously; if its clock runs 2% fast relative
    // to this phone's, a naive queue grows 72 seconds an hour. This one never
    // gets past the ceiling, and in a normal talk/pause rhythm never needs to
    // drop a word to stay there.
    const CHUNK = 0.25;
    let now = 0;
    let nextTime: number | null = null;
    let maxAhead = 0;
    let droppedSpeech = 0;
    for (let i = 0; i < (3600 / CHUNK) * 1.02; i++) {
      now += CHUNK / 1.02;
      // 6s of speech, then 4s of silence, over and over.
      const voiced = i % 40 < 24;
      const d = decideSchedule({ now, nextTime, voiced, muted: false });
      if (d.action === "play") nextTime = d.at + CHUNK;
      else if (voiced) droppedSpeech += 1;
      if (nextTime !== null) maxAhead = Math.max(maxAhead, nextTime - now);
    }
    expect(maxAhead).toBeLessThanOrEqual(MAX_AHEAD_S + CHUNK);
    expect(droppedSpeech).toBe(0);
  });

  it("drops speech rather than grow when there is never a pause", () => {
    const CHUNK = 0.25;
    let now = 0;
    let nextTime: number | null = null;
    let maxAhead = 0;
    let dropped = 0;
    for (let i = 0; i < 3600 * 4; i++) {
      now += CHUNK / 1.02;
      const d = decideSchedule({ now, nextTime, voiced: true, muted: false });
      if (d.action === "play") nextTime = d.at + CHUNK;
      else dropped += 1;
      if (nextTime !== null) maxAhead = Math.max(maxAhead, nextTime - now);
    }
    expect(maxAhead).toBeLessThanOrEqual(MAX_AHEAD_S + CHUNK);
    expect(dropped).toBeGreaterThan(0);
  });
});

describe("single-speaker isolation and the OpenAI arm, read from the source", () => {
  const gemini = readFileSync(new URL("../lib/call/interpreterGemini.ts", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../components/CallShell.tsx", import.meta.url), "utf8");

  it("feeds Gemini only the partner's track, never a microphone", () => {
    expect(gemini).toContain("bridgeInterpreterPcm(config.inputTrack, sendChunk)");
    expect(gemini).not.toMatch(/getUserMedia/);
  });

  it("keeps OpenAI the default and the gated hang-up report for it", () => {
    expect(shell).toContain("useState<InterpreterEngine>(DEFAULT_INTERPRETER_ENGINE)");
    expect(shell).toContain(
      'engineRef.current === "gemini" ? startGeminiInterpreter : startCallInterpreter'
    );
    expect(shell).toContain('if (finalSpend && finalSpend.engine !== "gemini")');
  });

  it("draws the engine picker for founders only", () => {
    expect(shell).toMatch(/\{founder \? \(\s*<div[^]*?"Gemini \(test\)"/);
  });
});
