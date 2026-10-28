import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The /tabletop brain A/B (Tom, 2026-10-21): Gemini Live Translate vs
// gpt-realtime, founders only, preview only, same voice. These pin the four
// things the comparison is worthless without — who may choose, failing closed
// without a key, an OpenAI arm that did not move, and arithmetic that reports
// what happened.

const mocks = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock("@/lib/authServer", () => ({ getUserFromRequest: mocks.user }));

import { brainEnvDefault, parseBrain, resolveBrain } from "@/lib/tabletop/brain";
import { buildTabletopSession } from "@/lib/tabletop/session";
import { buildTurnInstructions } from "@/lib/tabletop/instructions";
import { MEANING_FIRST_RULE } from "@/lib/translate/prompts";
import {
  addSegment,
  createSegmentClock,
  emptyTally,
  geminiUsd,
  parseSummary,
  percentile,
  summarize,
  tabletopLogLine
} from "@/lib/tabletop/metrics";
import { openaiSegmentPairing } from "@/lib/tabletop/openaiBrain";
import { createGeminiTurnCore, OUTPUT_QUIET_MS } from "@/lib/tabletop/geminiBrain";
import {
  buildGeminiSetup,
  GEMINI_LIVE_TRANSLATE_MODEL,
  GEMINI_NOT_CONFIGURED
} from "@/lib/tabletop/geminiSession";
import { POST as mintGemini } from "@/app/api/tabletop/gemini/route";
import { POST as postMetrics } from "@/app/api/tabletop/metrics/route";

const FOUNDER = { id: "tom", email: "xdrabbit@gmail.com" };
const CUSTOMER = { id: "ana", email: "ana@test.invalid" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("brain selection", () => {
  it("env default: openai unless TAOS_TABLETOP_BRAIN says gemini", () => {
    expect(brainEnvDefault(undefined)).toBe("openai");
    expect(brainEnvDefault("")).toBe("openai");
    expect(brainEnvDefault("gemni")).toBe("openai");
    expect(brainEnvDefault("gemini")).toBe("gemini");
    expect(brainEnvDefault(" Gemini ")).toBe("gemini");
    expect(brainEnvDefault("openai")).toBe("openai");
  });

  it("a founder's stored per-device toggle wins over the env default", () => {
    expect(resolveBrain({ founder: true, stored: "gemini", envDefault: "openai" })).toBe("gemini");
    expect(resolveBrain({ founder: true, stored: "openai", envDefault: "gemini" })).toBe("openai");
    expect(resolveBrain({ founder: true, stored: null, envDefault: "gemini" })).toBe("gemini");
    expect(resolveBrain({ founder: true, stored: "junk", envDefault: "openai" })).toBe("openai");
  });

  it("a non-founder is LOCKED to openai — env and storage cannot move them", () => {
    for (const stored of ["gemini", "openai", null, "junk"]) {
      for (const envDefault of ["gemini", "openai"] as const) {
        expect(resolveBrain({ founder: false, stored, envDefault })).toBe("openai");
      }
    }
  });

  it("parseBrain only knows the two arms", () => {
    expect(parseBrain("gemini")).toBe("gemini");
    expect(parseBrain("OPENAI")).toBe("openai");
    expect(parseBrain("claude")).toBeNull();
    expect(parseBrain(3)).toBeNull();
  });
});

describe("the OpenAI arm did not move", () => {
  // main's buildTabletopSession output as of e1c3c72, written out by hand.
  // If this fails, the control arm changed and the A/B is not an A/B.
  it("session builder output is byte-for-byte main's", () => {
    const direction = { source: "en", target: "es" };
    const session = buildTabletopSession({
      direction,
      model: "gpt-realtime",
      transcribeModel: "gpt-4o-mini-transcribe"
    });
    expect(JSON.stringify(session)).toBe(
      JSON.stringify({
        type: "realtime",
        model: "gpt-realtime",
        instructions: buildTurnInstructions(direction),
        output_modalities: ["text"],
        max_output_tokens: 300,
        truncation: { type: "retention_ratio", retention_ratio: 0.8, token_limits: { post_instructions: 100 } },
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.6,
              prefix_padding_ms: 300,
              silence_duration_ms: 550,
              create_response: true,
              interrupt_response: false
            }
          }
        }
      })
    );
  });

  it("the openai brain is today's live.ts with a read-only tap, not a rewrite", async () => {
    const { readFileSync } = await import("node:fs");
    const brainSrc = readFileSync("lib/tabletop/openaiBrain.ts", "utf8");
    expect(brainSrc).toContain("startTabletopLive(");
    const liveSrc = readFileSync("lib/tabletop/live.ts", "utf8");
    // The tap is called before handling and can't throw into it.
    expect(liveSrc).toMatch(/try \{\s*events\.onRealtimeEvent\?\.\(ev\);\s*\} catch/);
    // Still the one route, still the one session.update per turn.
    expect(liveSrc).toContain('fetch("/api/tabletop/realtime"');
    expect(liveSrc.match(/type: "session\.update"/g)?.length).toBe(1);
  });
});

describe("Gemini mint route fails closed", () => {
  const req = (body: unknown = { source: "en", target: "es" }) =>
    new NextRequest("https://taos.test/api/tabletop/gemini", { method: "POST", body: JSON.stringify(body) });

  it("no GEMINI_API_KEY → 503 'Gemini brain not configured', and Google is never called", async () => {
    mocks.user.mockResolvedValue(FOUNDER);
    vi.stubEnv("GEMINI_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await mintGemini(req());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(GEMINI_NOT_CONFIGURED);
    expect(GEMINI_NOT_CONFIGURED).toBe("Gemini brain not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a non-founder gets a 404 before the key is even looked at", async () => {
    mocks.user.mockResolvedValue(CUSTOMER);
    vi.stubEnv("GEMINI_API_KEY", "mock-key-not-a-secret");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await mintGemini(req())).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("signed out → 401", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await mintGemini(req())).status).toBe(401);
  });

  it("a founder with a key gets a socket URL with the setup locked in a one-use token, and no key", async () => {
    mocks.user.mockResolvedValue(FOUNDER);
    vi.stubEnv("GEMINI_API_KEY", "mock-key-not-a-secret");
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ name: "auth_tokens/abc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await mintGemini(req({ source: "es", target: "en" }));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.wsUrl).toContain("BidiGenerateContentConstrained?access_token=auth_tokens%2Fabc");
    expect(JSON.stringify(out)).not.toContain("mock-key-not-a-secret");
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(sent.uses).toBe(1);
    expect(sent.bidiGenerateContentSetup).toEqual(buildGeminiSetup("en"));
  });
});

describe("Gemini setup", () => {
  it("is Live Translate, audio-only out (the only modality it has), text read from the transcript", () => {
    const setup = buildGeminiSetup("zh");
    expect(GEMINI_LIVE_TRANSLATE_MODEL).toBe("gemini-3.5-live-translate-preview");
    expect(setup.model).toBe("models/gemini-3.5-live-translate-preview");
    expect(setup).toMatchObject({
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: { targetLanguageCode: "zh-Hans", echoTargetLanguage: false }
      },
      systemInstruction: { parts: [{ text: MEANING_FIRST_RULE() }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    });
    // On setup, not in generationConfig (1007 otherwise — the spike).
    expect(setup.generationConfig).not.toHaveProperty("outputAudioTranscription");
  });
});

describe("metrics aggregation", () => {
  it("percentile is nearest-rank: it only ever reports a segment that happened", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([700], 95)).toBe(700);
    const ten = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(ten, 50)).toBe(500);
    expect(percentile(ten, 95)).toBe(1000);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  });

  it("summarises a session and writes Tom's log line in Tom's order", () => {
    let t = emptyTally("gemini", 1_000);
    for (const [first, done] of [
      [400, 1200],
      [-80, 900],
      [600, 2000],
      [500, 1500]
    ]) {
      t = addSegment(t, { firstPartialMs: first, doneMs: done });
    }
    t = { ...t, errors: 1, reconnects: 2, estUsd: 0.01234 };
    const s = summarize(t, 185_400);
    expect(s).toMatchObject({
      brain: "gemini",
      seconds: 184,
      segments: 4,
      // -80 clamps to 0: the translation was already streaming at speech end.
      first_partial_ms_p50: 400,
      first_partial_ms_p95: 600,
      segment_done_ms_p50: 1200,
      segment_done_ms_p95: 2000,
      errors: 1,
      reconnects: 2
    });
    expect(tabletopLogLine(s)).toBe(
      "[taos-tabletop] brain=gemini seconds=184 segments=4 first_partial_ms_p50=400 " +
        "first_partial_ms_p95=600 segment_done_ms_p50=1200 segment_done_ms_p95=2000 " +
        "errors=1 reconnects=2 est_usd=0.0123 auto=0 detect_miss=0 forced_turns=0"
    );
  });

  it("the log route's parser refuses text — a transcript cannot reach the log", () => {
    const good = summarize(emptyTally("openai", 0), 60_000);
    expect(parseSummary(good)).toEqual(good);
    expect(parseSummary({ ...good, brain: "claude" })).toBeNull();
    expect(parseSummary({ ...good, segments: "hola, ¿qué tal?" })).toBeNull();
    expect(parseSummary({ ...good, est_usd: -1 })).toBeNull();
    const extra = parseSummary({ ...good, transcript: "secret" });
    expect(extra).not.toHaveProperty("transcript");
  });

  it("Gemini dollars use the spike's rates: $3.50/M in, $21/M out", () => {
    // One minute at 25 tok/s each way — the spike's 3.68¢/min.
    expect(geminiUsd(1500, 1500)).toBeCloseTo(0.03675, 6);
  });
});

describe("where a segment ends", () => {
  it("Gemini: last voiced chunk + 550 ms of quiet is a segment end; output is paired to it", () => {
    const clock = createSegmentClock(550);
    // voiced 0..1000, quiet after
    for (let at = 100; at <= 1000; at += 100) clock.chunk(at, true);
    for (let at = 1100; at <= 1600; at += 100) clock.chunk(at, false);
    expect(clock.ends()).toEqual([1000]);
    expect(clock.claim(2500, 3200)).toEqual({ firstPartialMs: 1500, doneMs: 2200 });
    // A second burst for speech already claimed measures from the same end.
    expect(clock.claim(4000, 4400)).toEqual({ firstPartialMs: 3000, doneMs: 3400 });
  });

  it("Gemini: an open run is closed by the turn ending, and early output reads as 0 after clamping", () => {
    const clock = createSegmentClock(550);
    for (let at = 100; at <= 5000; at += 100) clock.chunk(at, true);
    clock.flush();
    expect(clock.ends()).toEqual([5000]);
    // Interpreting while the speaker talks: first text before the voice end.
    const t = clock.claim(3000, 6500)!;
    expect(t.firstPartialMs).toBe(-2000);
    expect(addSegment(emptyTally("gemini", 0), t).firstPartialMs).toEqual([0]);
  });

  it("OpenAI: speech_stopped minus 550 ms is the end; one response per segment, in order", () => {
    const p = openaiSegmentPairing(550);
    p.event({ type: "input_audio_buffer.speech_started", audio_start_ms: 1000 }, 1_000);
    const stopped = p.event({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 2500 }, 3_050);
    expect(stopped.transcribedSeconds).toBeCloseTo(1.5);
    p.event({ type: "response.created" }, 3_100);
    p.event({ type: "response.output_text.delta", delta: "¿Dónde" }, 3_400);
    p.event({ type: "response.output_text.delta", delta: " está?" }, 3_500);
    const done = p.event({ type: "response.done", response: { usage: { input_tokens: 5 } } }, 3_700);
    expect(done.segment).toEqual({ text: "¿Dónde está?", firstPartialMs: 900, doneMs: 1200 });
    expect(done.usage).toEqual({ input_tokens: 5 });
    // A response that wrote nothing is not a segment.
    p.event({ type: "input_audio_buffer.speech_stopped" }, 5_000);
    p.event({ type: "response.created" }, 5_050);
    expect(p.event({ type: "response.done" }, 5_200).segment).toBeUndefined();
  });
});

describe("Gemini turn core", () => {
  it("assembles heard + translation from transcripts, segments on output quiet", () => {
    const partials: string[] = [];
    const segments: { text: string; doneMs: number | undefined }[] = [];
    const heard: string[] = [];
    const core = createGeminiTurnCore({
      onPartial: (d) => partials.push(d),
      onHeard: (h) => heard.push(h),
      onSegmentDone: (text, meta) => segments.push({ text, doneMs: meta?.doneMs })
    });
    for (let at = 100; at <= 1500; at += 100) core.chunk(at, true);
    for (let at = 1600; at <= 2200; at += 100) core.chunk(at, false);
    core.message({ serverContent: { inputTranscription: { text: "Where is" } } }, 900);
    core.message({ serverContent: { inputTranscription: { text: " the station?" } } }, 1600);
    expect(core.message({ usageMetadata: { promptTokenCount: 50, responseTokenCount: 50 } }, 2000)).toEqual({
      usageChanged: true
    });
    core.message({ serverContent: { outputTranscription: { text: "¿Dónde está" } } }, 3000);
    core.message({ serverContent: { outputTranscription: { text: " la estación?" } } }, 3300);
    core.tick(3300 + OUTPUT_QUIET_MS - 1);
    expect(segments).toEqual([]);
    core.tick(3300 + OUTPUT_QUIET_MS);
    expect(segments).toEqual([{ text: "¿Dónde está la estación?", doneMs: 1800 }]);
    core.message({ serverContent: { outputTranscription: { text: "Gracias." } } }, 5000);
    expect(partials).toEqual(["¿Dónde está", " la estación?", " ", "Gracias."]);
    expect(heard.at(-1)).toBe("Where is the station?");
    expect(core.finish()).toEqual({
      heard: "Where is the station?",
      translation: "¿Dónde está la estación? Gracias."
    });
    expect(core.tokens()).toEqual({ promptTokens: 50, responseTokens: 50 });
  });

  it("drain: waits for output after the last voice, then quiet; gives up on silence", () => {
    const core = createGeminiTurnCore({});
    core.chunk(1000, true);
    core.endSpeech();
    expect(core.drained(1500, 1100)).toBe(false);
    core.message({ serverContent: { outputTranscription: { text: "Hola" } } }, 2500);
    expect(core.drained(2500 + OUTPUT_QUIET_MS - 1, 1100)).toBe(false);
    expect(core.drained(2500 + OUTPUT_QUIET_MS, 1100)).toBe(true);

    const mute = createGeminiTurnCore({});
    mute.chunk(1000, true);
    mute.endSpeech();
    expect(mute.drained(4000, 1100)).toBe(false);
    expect(mute.drained(5100, 1100)).toBe(true);
  });
});

describe("metrics log route", () => {
  const req = (body: unknown) =>
    new NextRequest("https://taos.test/api/tabletop/metrics", { method: "POST", body: JSON.stringify(body) });
  const summary = summarize(addSegment(emptyTally("openai", 0), { firstPartialMs: 300, doneMs: 800 }), 90_000);

  it("a founder's numbers become exactly one [taos-tabletop] line", async () => {
    mocks.user.mockResolvedValue(FOUNDER);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await postMetrics(req(summary));
    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(tabletopLogLine(summary));
    log.mockRestore();
  });

  it("non-founders 404, junk 400, nothing logged", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.user.mockResolvedValue(CUSTOMER);
    expect((await postMetrics(req(summary))).status).toBe(404);
    mocks.user.mockResolvedValue(FOUNDER);
    expect((await postMetrics(req({ brain: "openai", text: "hola" }))).status).toBe(400);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
