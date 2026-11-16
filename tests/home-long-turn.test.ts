// The home screen's long turn: ten minutes, recorded in chunks.
//
// Tom, 2026-11-15, after he and Liz hit the five-minute cap seven-plus times
// in one day: raise the HOME turn to ten minutes, chunked, with a hard stop —
// "we don't want to go 13 minutes and lose 13 minutes of a side".
// lib/translate/longTurn.ts has the design. This file pins it:
//
//   * the cap: ten minutes by default, TAOS_HOME_MAX_TURN_MS to change it —
//     for PAYING users and founders; free users keep five (Tom and Liz,
//     2026-11-15 20:32 MT: the ten-minute turn is a paid benefit) — and enforced by a question asked again and again — never one timer
//     (2026-11-10: a lost setTimeout let a turn run 37 minutes);
//   * the recorder: sequential MediaRecorders on one stream, stop-then-start;
//   * the pipeline: each chunk transcribed on its own, ONE translation over
//     the stitched text;
//   * the bounded loss: a failed chunk is a marker, not a failed turn;
//   * review: one kept file for the whole turn, rec_ms the whole turn;
//   * quota: a chunked turn is one translation, and /try cannot chunk.
//
// The seam between two real recordings is measured in a browser, not here:
// tests/live-fire/chunk-boundary-browser-check.mjs.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";
import {
  countLostMarkers,
  formatClock,
  HOME_CHUNK_MS,
  HOME_MAX_CHUNKS,
  HOME_MAX_TURN_MS_CEILING,
  HOME_MAX_TURN_FREE_MS_DEFAULT,
  HOME_MAX_TURN_MS_DEFAULT,
  homeMaxTurnFreeMs,
  homeMaxTurnMs,
  homeTurnCapMs,
  LONG_SPEECH_FROM_CHARS,
  longTurnKnobs,
  lostMarker,
  parsePriorField,
  serializePrior,
  SPEECH_PIECE_MAX_CHARS,
  splitForSpeech,
  stitchTranscripts,
  translateTimeoutFor,
  turnCapReached,
  turnElapsedMs,
  turnPieces,
  weaveSegments,
  weaveTranslations
} from "@/lib/translate/longTurn";
import { createChunkedRecorder, type RecordedChunk } from "@/lib/translate/chunkedRecorder";
import { rampWindows } from "@/lib/translate/recorder";
import { isSubscriber, type Profile } from "@/lib/supabase";
import { isFounder } from "@/lib/release";
import { ffmpegPath } from "@/lib/translate/normalize";

// ── Mocks for the route ────────────────────────────────────────────────────
const guardSpend = vi.fn();
vi.mock("@/lib/spendGuard", () => ({ guardSpend: (...a: unknown[]) => guardSpend(...a) }));

const transcribeAudio = vi.fn();
vi.mock("@/lib/translate/transcribe", () => ({
  transcribeAudio: (...a: unknown[]) => transcribeAudio(...a),
  getTranscribeModel: () => "gpt-4o-transcribe",
  defaultTranscribeModel: () => "gpt-4o-transcribe",
  autoTranscribeModel: () => "gpt-4o-transcribe"
}));

const speakerKeepsAudio = vi.fn();
const keepTurnForReview = vi.fn();
vi.mock("@/lib/review/capture", () => ({
  speakerKeepsAudio: (...a: unknown[]) => speakerKeepsAudio(...a),
  keepTurnForReview: (...a: unknown[]) => keepTurnForReview(...a)
}));

const waits: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => void waits.push(p) }));

// The review store, as lib/review/chunks.ts sees it: an in-memory bucket.
const bucket = new Map<string, { bytes: Uint8Array; created_at: string }>();
const speakers = [{ id: "u1", email: "founder@example.com" }];
vi.mock("@/lib/review/store", async (original) => ({
  ...(await original<typeof import("@/lib/review/store")>()),
  uploadReviewAudio: async (path: string, bytes: ArrayBuffer | Uint8Array) => {
    if (bucket.has(path)) throw new Error("exists");
    bucket.set(path, { bytes: new Uint8Array(bytes as ArrayBuffer), created_at: new Date().toISOString() });
  },
  downloadReviewAudio: async (path: string) => {
    const hit = bucket.get(path);
    if (!hit) throw new Error("missing");
    return hit.bytes;
  },
  removeReviewAudio: async (paths: string[]) => {
    for (const p of paths) bucket.delete(p);
  },
  listReviewSpeakers: async () => speakers
}));
vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: {
    storage: {
      from: () => ({
        list: async (folder: string) => ({
          data: [...bucket.entries()]
            .filter(([path]) => path.startsWith(`${folder}/`))
            .map(([path, o]) => ({ name: path.slice(folder.length + 1), created_at: o.created_at })),
          error: null
        }),
        remove: async (paths: string[]) => {
          for (const p of paths) bucket.delete(p);
          return { data: paths.map((name) => ({ name })), error: null };
        }
      })
    }
  }
}));

const TURN_ID = "11111111-2222-4333-8444-555555555555";
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

function request(fields: Record<string, string>, { audio = true }: { audio?: boolean } = {}) {
  const form = new FormData();
  if (audio) form.append("audio", new File([new Uint8Array(2000)], "turn.webm", { type: "audio/webm" }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new NextRequest("http://localhost/api/translate", { method: "POST", body: form });
}

const manual = { sourceLanguage: "en", targetLanguage: "es", tone: "detailed" };

async function loadRoute() {
  vi.resetModules();
  return import("@/app/api/translate/route");
}

function lines(tag: string): string[] {
  return logSpy.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.startsWith(tag));
}

function field(line: string, key: string): string | undefined {
  return new RegExp(`(?:^| )${key}=(\\S+)`).exec(line)?.[1];
}

function allConsoleOutput(): string {
  return [logSpy, vi.mocked(console.warn), vi.mocked(console.error)]
    .flatMap((s) => s.mock.calls)
    .map((c) => c.map(String).join(" "))
    .join("\n");
}

/** What the translator was asked to translate. */
function translatedText(): string {
  const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)) as {
    messages: Array<{ role: string; content: string }>;
  };
  return body.messages.find((m) => m.role === "user")?.content ?? "";
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  bucket.clear();
  waits.length = 0;
  guardSpend.mockReset().mockResolvedValue({ ok: true, user: { id: "u1" }, anonymous: false });
  transcribeAudio.mockReset().mockResolvedValue("and that is where the story ends");
  speakerKeepsAudio.mockReset().mockResolvedValue(false);
  keepTurnForReview.mockReset().mockResolvedValue("kept");
  fetchSpy.mockReset().mockImplementation(async () => chat("la traducción completa"));
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

// ───────────────────────────────────────────────────────────────────────────
describe("the cap", () => {
  it("is ten minutes unless TAOS_HOME_MAX_TURN_MS says otherwise", () => {
    expect(HOME_MAX_TURN_MS_DEFAULT).toBe(600000);
    expect(homeMaxTurnMs(undefined)).toBe(600000);
    expect(homeMaxTurnMs("")).toBe(600000);
    expect(homeMaxTurnMs("nonsense")).toBe(600000);
    expect(homeMaxTurnMs("480000")).toBe(480000);
  });

  it("the override is bounded: a kept turn must still fit one Redo upload", () => {
    expect(homeMaxTurnMs("1000")).toBe(60000);
    expect(homeMaxTurnMs("99999999")).toBe(HOME_MAX_TURN_MS_CEILING);
    // 16 kHz mono 16-bit WAV, 25 MB transcriber limit.
    expect((HOME_MAX_TURN_MS_CEILING / 1000) * 32000).toBeLessThan(25 * 1024 * 1024);
  });

  it("a chunk is 4.5 minutes — under the route's 300 s — and ten minutes is three of them", () => {
    expect(HOME_CHUNK_MS).toBe(270000);
    const route = readFileSync("app/api/translate/route.ts", "utf8");
    const maxDuration = Number(/export const maxDuration = (\d+)/.exec(route)?.[1]);
    expect(HOME_CHUNK_MS).toBeLessThan(maxDuration * 1000);
    expect(Math.ceil(HOME_MAX_TURN_MS_DEFAULT / HOME_CHUNK_MS)).toBe(3);
    expect(HOME_MAX_CHUNKS).toBeGreaterThanOrEqual(Math.ceil(HOME_MAX_TURN_MS_CEILING / HOME_CHUNK_MS));
  });

  it("is reached by whichever clock says so — a stalled clock cannot hide it", () => {
    const start = { perf: 1000, wall: 1_700_000_000_000 };
    // Both clocks agree.
    expect(turnCapReached(start, { perf: 1000 + 599000, wall: start.wall + 599000 }, 600000)).toBe(false);
    expect(turnCapReached(start, { perf: 1000 + 600000, wall: start.wall + 600000 }, 600000)).toBe(true);
    // performance.now() slept with the phone; the wall clock did not.
    expect(turnCapReached(start, { perf: 1000 + 20000, wall: start.wall + 2_236_000 }, 600000)).toBe(true);
    // The wall clock was set back; performance.now() kept counting.
    expect(turnCapReached(start, { perf: 1000 + 700000, wall: start.wall - 5000 }, 600000)).toBe(true);
    expect(turnElapsedMs(start, { perf: 0, wall: 0 })).toBe(0);
  });

  it("the home screen asks on an interval, every frame and on return — never one setTimeout", () => {
    const shell = readFileSync("components/TranslatorShell.tsx", "utf8");
    expect(shell).not.toContain("setTimeout(stopRecording");
    expect(shell).not.toContain("MAX_TURN_DURATION_MS");
    expect(shell).toContain("capTickRef.current = window.setInterval(() => checkTurnRef.current(), 1000);");
    expect(shell).toContain('document.addEventListener("visibilitychange", ask);');
    expect(shell).toContain('window.addEventListener("pageshow", ask);');
    expect(shell).toContain("if (turnCapReached(turnStartRef.current, nowClock(), turnCapMs)) {");
    // The frame loop asks too.
    const ramp = shell.slice(shell.indexOf("function tickRamp()"), shell.indexOf("function stopRamp()"));
    expect(ramp).toContain("checkTurn();");
  });

  it("the wrap-up ramp counts down to the WHOLE turn's cap, not a chunk's", () => {
    const shell = readFileSync("components/TranslatorShell.tsx", "utf8");
    expect(shell).toContain("const rampWin = rampWindows(turnCapMs);");
    expect(shell).toContain("const remaining = turnCapMs - turnElapsedMs(turnStartRef.current, nowClock());");
    expect(shell).toContain("maxTurnMs = HOME_MAX_TURN_MS_DEFAULT");
    expect(readFileSync("app/page.tsx", "utf8")).toContain("homeMaxTurnMs(process.env.TAOS_HOME_MAX_TURN_MS)");
  });

  it("at the cap the turn is stopped and processed — the audio is never discarded", () => {
    const shell = readFileSync("components/TranslatorShell.tsx", "utf8");
    const check = shell.slice(shell.indexOf("function checkTurn()"), shell.indexOf("checkTurnRef.current = checkTurn;"));
    // stopRecording() is the same function the Stop button calls.
    expect(check).toContain(
      "if (turnCapReached(turnStartRef.current, nowClock(), turnCapMs)) {\n" +
        "      // Hard stop — and the normal flow on everything captured.\n" +
        "      stopRecording();"
    );
    expect(shell).toContain("if (chunk.final) void handleRecordingStopped(turn, chunk);");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tom and Liz, 2026-11-15 20:32 MT, on PR #134: "the 10-minute cap is a paid
// benefit. Free-tier users keep today's 5-minute cap." Do not flip either
// side of this without their say-so.
describe("the cap is tiered: ten minutes is a paid benefit", () => {
  const profile = (over: Partial<Profile>): Profile =>
    ({ id: "u", email: "someone@example.com", subscription_status: "free", tier: null, ...over }) as unknown as Profile;
  // Exactly what TranslatorShell computes, with the defaults app/page.tsx hands down.
  const capFor = (p: Profile | null, email = "someone@example.com") =>
    homeTurnCapMs(isSubscriber(p) || isFounder(email), homeMaxTurnMs(undefined), homeMaxTurnFreeMs(undefined));

  it("a free user keeps five minutes; a paying one gets ten", () => {
    expect(HOME_MAX_TURN_FREE_MS_DEFAULT).toBe(300000);
    expect(capFor(profile({}))).toBe(300000);
    expect(capFor(profile({ subscription_status: "active", tier: "basic" }))).toBe(600000);
    expect(capFor(profile({ subscription_status: "active", tier: "premium" }))).toBe(600000);
    expect(capFor(profile({ subscription_status: "comp" }))).toBe(600000);
  });

  it("anything that is not a live subscription is free: trial, canceled, past due, no profile", () => {
    for (const status of ["trialing", "canceled", "past_due", "incomplete", "unpaid", ""]) {
      expect(capFor(profile({ subscription_status: status, tier: "premium" } as Partial<Profile>))).toBe(300000);
    }
    expect(capFor(null)).toBe(300000);
  });

  it("a founder gets ten whatever their profile says", () => {
    expect(capFor(profile({}), "xdrabbit@gmail.com")).toBe(600000);
    expect(capFor(null, "lizmariett@gmail.com")).toBe(600000);
  });

  it("the home screen reads the tier from the profile the Stripe webhook writes — no new entitlement", () => {
    const shell = readFileSync("components/TranslatorShell.tsx", "utf8");
    expect(shell).toContain("const subscriber = isSubscriber(profile);");
    expect(shell).toContain(
      "const turnCapMs = homeTurnCapMs(subscriber || isFounder(email), maxTurnMs, maxTurnFreeMs);"
    );
    expect(shell).toContain("maxTurnFreeMs = HOME_MAX_TURN_FREE_MS_DEFAULT");
    // Nothing in the shell still counts down to the paid cap directly.
    expect(shell).not.toContain("rampWindows(maxTurnMs)");
    expect(shell).not.toContain("nowClock(), maxTurnMs)");
    expect(shell).not.toContain("maxTurnMs - turnElapsedMs");
    const page = readFileSync("app/page.tsx", "utf8");
    expect(page).toContain("homeMaxTurnFreeMs(process.env.TAOS_HOME_MAX_TURN_FREE_MS, maxTurnMs)");
    const app = readFileSync("components/AppShell.tsx", "utf8");
    expect(app).toContain("maxTurnMs={maxTurnMs}");
    expect(app).toContain("maxTurnFreeMs={maxTurnFreeMs}");
  });

  it("the wrap-up glow follows the user's own cap: 4:30 free, 9:30 paid", () => {
    expect(300000 - rampWindows(capFor(profile({}))).early).toBe(270000);
    expect(600000 - rampWindows(capFor(profile({ subscription_status: "comp" }))).early).toBe(570000);
  });

  it("TAOS_HOME_MAX_TURN_MS stays the paid knob; TAOS_HOME_MAX_TURN_FREE_MS is the free one", () => {
    expect(homeMaxTurnFreeMs(undefined)).toBe(300000);
    expect(homeMaxTurnFreeMs("")).toBe(300000);
    expect(homeMaxTurnFreeMs("nonsense")).toBe(300000);
    expect(homeMaxTurnFreeMs("180000")).toBe(180000);
    expect(homeMaxTurnFreeMs("1000")).toBe(60000);
    // The paid override does not move a free user...
    expect(homeTurnCapMs(false, homeMaxTurnMs("720000"), homeMaxTurnFreeMs(undefined, homeMaxTurnMs("720000")))).toBe(300000);
    expect(homeTurnCapMs(true, homeMaxTurnMs("720000"), homeMaxTurnFreeMs(undefined, homeMaxTurnMs("720000")))).toBe(720000);
  });

  it("free is never longer than paid, whatever the knobs say", () => {
    expect(homeMaxTurnFreeMs("900000")).toBe(600000);
    expect(homeMaxTurnFreeMs(undefined, 120000)).toBe(120000);
    expect(homeTurnCapMs(false, 120000, 300000)).toBe(120000);
  });

  it("a free turn at its cap is at most two chunks — and under 4.5 minutes it is one recording, as before", () => {
    expect(Math.ceil(HOME_MAX_TURN_FREE_MS_DEFAULT / HOME_CHUNK_MS)).toBe(2);
    expect(HOME_CHUNK_MS).toBeLessThan(HOME_MAX_TURN_FREE_MS_DEFAULT);
  });
});

describe("the chunked recorder", () => {
  class FakeRecorder {
    static log: string[] = [];
    static made = 0;
    static failFrom = Infinity;
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((ev: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    readonly n: number;
    constructor(
      public stream: unknown,
      public options: MediaRecorderOptions
    ) {
      if (FakeRecorder.made >= FakeRecorder.failFrom) throw new Error("NotSupportedError");
      this.n = FakeRecorder.made++;
    }
    start(timeslice: number) {
      this.state = "recording";
      FakeRecorder.log.push(`start${this.n}:${timeslice}`);
    }
    stop() {
      this.state = "inactive";
      FakeRecorder.log.push(`stop${this.n}`);
      // A real recorder flushes, then fires stop, as later tasks.
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([`audio${this.n}`]) });
        this.onstop?.();
      });
    }
  }

  function rig(chunkMs = 1000) {
    FakeRecorder.log = [];
    FakeRecorder.made = 0;
    FakeRecorder.failFrom = Infinity;
    let clock = 0;
    const got: RecordedChunk[] = [];
    const stream = { id: "the-one-stream" };
    const recorder = createChunkedRecorder({
      stream: stream as unknown as MediaStream,
      mime: "audio/webm",
      bitsPerSecond: 32000,
      chunkMs,
      onChunk: (c) => got.push(c),
      now: () => clock,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder
    });
    return { recorder, got, advance: (ms: number) => (clock += ms), flush: () => new Promise((r) => setTimeout(r, 0)) };
  }

  it("a turn that never reaches a chunk's length is one recording, flushed every second", async () => {
    const { recorder, got, advance, flush } = rig();
    recorder.start();
    expect(FakeRecorder.log).toEqual(["start0:1000"]);
    advance(999);
    expect(recorder.shouldRoll()).toBe(false);
    recorder.stop();
    await flush();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ index: 0, final: true, ms: 999 });
    expect(await got[0].blob.text()).toBe("audio0");
    expect(recorder.state).toBe("inactive");
  });

  it("rolls stop-then-start in one task, on the same stream, and numbers the chunks", async () => {
    const { recorder, got, advance, flush } = rig();
    recorder.start();
    advance(1000);
    expect(recorder.shouldRoll()).toBe(true);
    expect(recorder.roll()).toBe(true);
    // No await between the two: the gap is the encoder's turnaround only.
    expect(FakeRecorder.log).toEqual(["start0:1000", "stop0", "start1:1000"]);
    expect(recorder.shouldRoll()).toBe(false);
    advance(400);
    recorder.stop();
    await flush();
    expect(got.map((c) => [c.index, c.final, c.ms])).toEqual([
      [0, false, 1000],
      [1, true, 400]
    ]);
    expect(await got[0].blob.text()).toBe("audio0");
    expect(await got[1].blob.text()).toBe("audio1");
    expect(recorder.chunkCount).toBe(2);
  });

  it("a phone that refuses a second recorder ends the turn with what it has", async () => {
    const { recorder, got, advance, flush } = rig();
    recorder.start();
    FakeRecorder.failFrom = 1;
    advance(1000);
    expect(recorder.roll()).toBe(false);
    await flush();
    // The chunk that had just closed IS the turn — delivered as final.
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ index: 0, final: true });
    expect(recorder.state).toBe("inactive");
    expect(recorder.shouldRoll()).toBe(false);
  });

  it("the home screen records through it and sends each closed chunk at once", () => {
    const shell = readFileSync("components/TranslatorShell.tsx", "utf8");
    expect(shell).toContain("const recorder = createChunkedRecorder({");
    expect(shell).toContain("else startPart(turn, chunk);");
    expect(shell).toContain('form.append("chunk_part", "1");');
    // One mic permission, one stream, for the whole turn.
    expect(shell.match(/getUserMedia\(\{ audio: true \}\)/g)).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("stitching", () => {
  it("joins the chunks in order; an empty chunk is skipped, a failed one is marked", () => {
    const s = stitchTranscripts(
      [
        { text: "first part.", ms: 270000 },
        { text: null, ms: 270000 },
        { text: "  ", ms: 5000 },
        { text: "last part.", ms: 60000 }
      ],
      "en"
    );
    expect(s.text).toBe("first part. [audio lost 4:30] last part.");
    expect(s).toMatchObject({ chunks: 4, failed: 1, heard: true });
  });

  it("the marker: Tom's words, English and Spanish, English for everyone else", () => {
    expect(lostMarker("es", 30000)).toBe("[audio perdido 0:30]");
    expect(lostMarker("en", 270000)).toBe("[audio lost 4:30]");
    expect(lostMarker("sm", 61400)).toBe("[audio lost 1:01]");
    expect(formatClock(599600)).toBe("10:00");
    // Spanish chrome copy is pending Liz, like every agent-written string.
    expect(readFileSync("lib/translate/longTurn.ts", "utf8")).toContain(
      'es: "audio perdido" // pendiente de revisión por Liz'
    );
  });

  it("markers alone are not a turn", () => {
    expect(stitchTranscripts([{ text: null, ms: 1000 }, { text: "", ms: 1000 }], "en").heard).toBe(false);
  });

  it("a turn with a hole is runs of speech and the holes between them", () => {
    expect(
      turnPieces([
        { text: "one", ms: 1 },
        { text: "two", ms: 1 },
        { text: null, ms: 270000 },
        { text: "", ms: 1 },
        { text: "three", ms: 1 }
      ])
    ).toEqual([
      { kind: "text", text: "one two" },
      { kind: "lost", ms: 270000 },
      { kind: "text", text: "three" }
    ]);
    expect(countLostMarkers("[audio lost 4:30] and [Audio verloren 0:05]")).toBe(2);
  });

  it("the marker's PLACE is this code's, not the translator's (it dropped it 3 of 3, live, 11/15)", () => {
    const pieces = turnPieces([
      { text: null, ms: 5000 },
      { text: "one", ms: 1 },
      { text: null, ms: 270000 },
      { text: "three", ms: 1 }
    ]);
    expect(weaveTranslations(pieces, ["uno", "tres"], "es")).toBe("[audio perdido 0:05] uno [audio perdido 4:30] tres");
  });

  it("an auto turn: a hole is marked on both sides' text, and one direction stays ONE segment", () => {
    const seg = (sourceLanguage: string, original: string, translation: string) => ({
      sourceLanguage,
      targetLanguage: sourceLanguage === "en" ? "es" : "en",
      original,
      translation
    });
    const pieces = turnPieces([
      { text: "one", ms: 1 },
      { text: null, ms: 45000 },
      { text: "three", ms: 1 }
    ]);
    // Same direction either side of the hole: one segment, one row, one voice.
    expect(weaveSegments(pieces, [[seg("en", "one", "uno")], [seg("en", "three", "tres")]], "en")).toEqual([
      seg("en", "one [audio lost 0:45] three", "uno [audio perdido 0:45] tres")
    ]);
    // The speaker changed across the hole: two segments, the hole on the first.
    expect(weaveSegments(pieces, [[seg("en", "one", "uno")], [seg("es", "tres", "three")]], "es")).toEqual([
      seg("en", "one [audio perdido 0:45]", "uno [audio perdido 0:45]"),
      seg("es", "tres", "three")
    ]);
    // A turn that OPENS with a hole marks the first thing heard after it.
    expect(weaveSegments(turnPieces([{ text: null, ms: 5000 }, { text: "x", ms: 1 }]), [[seg("es", "equis", "x")]], "en")).toEqual([
      seg("es", "[audio lost 0:05] equis", "[audio lost 0:05] x")
    ]);
  });

  it("the prior field round-trips, and anything malformed is null", () => {
    const parts = [
      { text: "hello", ms: 270000 },
      { text: null, ms: 1234 }
    ];
    expect(parsePriorField(serializePrior(parts))).toEqual(parts);
    expect(parsePriorField(null)).toBeNull();
    expect(parsePriorField("")).toBeNull();
    expect(parsePriorField("{")).toBeNull();
    expect(parsePriorField("[]")).toBeNull();
    expect(parsePriorField(JSON.stringify([{ nope: 1 }]))).toBeNull();
    expect(parsePriorField(JSON.stringify(Array(HOME_MAX_CHUNKS).fill({ text: "x", ms: 1 })))).toBeNull();
    expect(parsePriorField(JSON.stringify([{ text: "x".repeat(30000), ms: 1 }]))).toBeNull();
  });

  it("a long translation is given more time, bounded well under the route's 300 s", () => {
    expect(translateTimeoutFor(500, 60000)).toBe(60000);
    expect(translateTimeoutFor(4000, 60000)).toBe(60000);
    expect(translateTimeoutFor(8000, 60000)).toBe(120000);
    expect(translateTimeoutFor(50000, 60000)).toBe(150000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("/api/translate — a part (a chunk that closed mid-turn)", () => {
  // Six seconds: under the short-transcript floor, so a few fixture words
  // are a phrase and not a retry (tests/stt-short-retry.test.ts).
  const part = { ...manual, chunk_part: "1", chunk_index: "0", chunk_ms: "6000", turn_id: TURN_ID };

  it("is transcribed and nothing else: no translation, its own log line, no timing line", async () => {
    transcribeAudio.mockResolvedValue("the first four and a half minutes");
    const { POST } = await loadRoute();
    const res = await POST(request(part));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chunk: { index: 0, text: "the first four and a half minutes" } });
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines("[taos-translate-timing]")).toHaveLength(0);
    const [line] = lines("[taos-translate-chunk]");
    expect(line).toMatch(/^\[taos-translate-chunk\] status=ok http=200 mode=manual src=en index=0 chunk_ms=6000 /);
    expect(field(line, "src_chars")).toBe(String("the first four and a half minutes".length));
    expect(allConsoleOutput()).not.toContain("four and a half");
  });

  it("a quiet chunk is an empty transcript, not an error", async () => {
    transcribeAudio.mockResolvedValue("");
    const { POST } = await loadRoute();
    const res = await POST(request(part));
    expect(res.status).toBe(200);
    expect((await res.json()).chunk.text).toBe("");
  });

  it("words-per-second is measured against the CHUNK, not the turn", async () => {
    // 20 words in a 10 s chunk is speech. Against the turn's ten minutes it
    // would read 0.03 words/s and buy a pointless retry on every last chunk.
    transcribeAudio.mockResolvedValue(Array(20).fill("word").join(" "));
    const { POST } = await loadRoute();
    await POST(request({ ...manual, prior: serializePrior([{ text: "earlier", ms: 270000 }]), chunk_index: "1", chunk_ms: "10000", rec_ms: "600000" }));
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    const [line] = lines("[taos-translate-timing]");
    expect(field(line, "wps")).toBe("2");
    expect(field(line, "rec_ms")).toBe("600000");
  });

  it("a failed part is an error the phone turns into a lost chunk", async () => {
    transcribeAudio.mockRejectedValue(Object.assign(new Error("Transcription failed"), { upstreamStatus: 500 }));
    const { POST } = await loadRoute();
    const res = await POST(request(part));
    expect(res.status).toBe(502);
    expect(field(lines("[taos-translate-chunk]")[0], "err")).toBe("transcribe_500");
    // …and the phone's half of that:
    const shell = readFileSync("components/TranslatorShell.tsx", "utf8");
    const fn = shell.slice(shell.indexOf("async function transcribePart("), shell.indexOf("function startPart("));
    expect(fn).toContain("return { text: null, ms };");
    expect(fn).not.toContain("setError(");
    expect(fn).not.toContain('setStatus("error")');
  });

  it("the anonymous /try allowance cannot chunk its way past its one short clip", async () => {
    guardSpend.mockResolvedValue({ ok: true, user: null, anonymous: true });
    const { POST } = await loadRoute();
    for (const fields of [part, { ...manual, prior: serializePrior([{ text: "x", ms: 1 }]) }]) {
      const res = await POST(request(fields));
      expect(res.status).toBe(400);
    }
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a chunk index past the most a turn can have, and a part that claims to be final too", async () => {
    const { POST } = await loadRoute();
    expect((await POST(request({ ...part, chunk_index: String(HOME_MAX_CHUNKS) }))).status).toBe(400);
    expect((await POST(request({ ...part, prior: serializePrior([{ text: "x", ms: 1 }]) }))).status).toBe(400);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("/api/translate — the last chunk of a long turn", () => {
  const prior = serializePrior([
    { text: "It began in the morning.", ms: 270000 },
    { text: "Then we drove north.", ms: 270000 }
  ]);
  const final = { ...manual, prior, chunk_index: "2", chunk_ms: "6000", rec_ms: "546000", turn_id: TURN_ID, stitch_ms: "12" };

  it("stitches in order and translates ONCE, the whole text", async () => {
    const { POST } = await loadRoute();
    const res = await POST(request(final));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(translatedText()).toBe("It began in the morning. Then we drove north. and that is where the story ends");
    expect(body.original).toBe("It began in the morning. Then we drove north. and that is where the story ends");
    expect(body.translation).toBe("la traducción completa");
  });

  it("the timing line: one per turn, with chunks=, chunk_fail= and stitch_ms=", async () => {
    const { POST } = await loadRoute();
    await POST(request(final));
    const timing = lines("[taos-translate-timing]");
    expect(timing).toHaveLength(1);
    expect(timing[0]).toMatch(/ norm_ms=\S+ chunks=3 chunk_fail=0 stitch_ms=12$/);
    expect(field(timing[0], "rec_ms")).toBe("546000");
    expect(lines("[taos-translate-chunk]")).toHaveLength(0);
    expect(allConsoleOutput()).not.toContain("drove north");
  });

  it("a lost chunk is a marker exactly where it was lost, and the turn goes on", async () => {
    // Each side of the hole is translated on its own; the marker between
    // them is placed by the route, in the listener's language.
    fetchSpy.mockImplementation(async (_url: unknown, init: RequestInit) => {
      const said = (JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> }).messages.find(
        (m) => m.role === "user"
      )?.content;
      return chat(said === "It began in the morning." ? "Empezó por la mañana." : "y ahí termina la historia");
    });
    const { POST } = await loadRoute();
    const res = await POST(
      request({
        ...final,
        marker_lang: "en",
        prior: serializePrior([
          { text: "It began in the morning.", ms: 270000 },
          { text: null, ms: 270000 }
        ])
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(body.original).toBe("It began in the morning. [audio lost 4:30] and that is where the story ends");
    expect(body.translation).toBe("Empezó por la mañana. [audio perdido 4:30] y ahí termina la historia");
    expect(lines("[taos-translate-timing]")[0]).toMatch(/ chunks=3 chunk_fail=1 stitch_ms=12$/);
    // The translator never sees a marker to drop.
    for (const call of fetchSpy.mock.calls) expect(String((call[1] as RequestInit).body)).not.toContain("audio lost");
  });

  it("the transcript's marker is in the phone owner's language when the phone says which", async () => {
    const { POST } = await loadRoute();
    const res = await POST(request({ ...final, marker_lang: "es", prior: serializePrior([{ text: null, ms: 30000 }]) }));
    const body = await res.json();
    expect(body.original).toBe("[audio perdido 0:30] and that is where the story ends");
    expect(body.translation).toBe("[audio perdido 0:30] la traducción completa");
  });

  it("with nothing lost it is ONE translation of the whole text — never a call per chunk", async () => {
    const { POST } = await loadRoute();
    await POST(request(final));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("the LAST chunk failing is bounded loss too: the earlier chunks still translate", async () => {
    transcribeAudio.mockRejectedValue(Object.assign(new Error("Transcription failed"), { upstreamStatus: 500 }));
    const { POST } = await loadRoute();
    const res = await POST(request(final));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(translatedText()).toBe("It began in the morning. Then we drove north.");
    expect(body.original).toBe("It began in the morning. Then we drove north. [audio lost 0:06]");
    expect(body.translation).toBe("la traducción completa [audio perdido 0:06]");
    expect(lines("[taos-translate-timing]")[0]).toMatch(/ status=ok .* chunks=3 chunk_fail=1 /);
  });

  it("a one-recording turn whose transcription fails still fails — nothing to fall back on", async () => {
    transcribeAudio.mockRejectedValue(Object.assign(new Error("Transcription failed"), { upstreamStatus: 500 }));
    const { POST } = await loadRoute();
    const res = await POST(request({ ...manual }));
    expect(res.status).toBe(502);
    expect(field(lines("[taos-translate-timing]")[0], "err")).toBe("transcribe_500");
  });

  it("every chunk lost is an error, not 'nothing was heard'", async () => {
    transcribeAudio.mockRejectedValue(new Error("Transcription failed"));
    const { POST } = await loadRoute();
    const res = await POST(request({ ...final, prior: serializePrior([{ text: null, ms: 270000 }]) }));
    expect(res.status).toBe(502);
    expect(field(lines("[taos-translate-timing]")[0], "err")).toBe("chunks_failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ten quiet minutes is still 'nothing was heard'", async () => {
    transcribeAudio.mockResolvedValue("");
    const { POST } = await loadRoute();
    const res = await POST(request({ ...final, prior: serializePrior([{ text: "", ms: 270000 }]) }));
    expect(res.status).toBe(422);
  });

  it("a stop in the instant after a roll: no audio of its own, the earlier chunks are the turn", async () => {
    const { POST } = await loadRoute();
    const res = await POST(request({ ...final, audio_mime: "audio/webm" }, { audio: false }));
    expect(res.status).toBe(200);
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(translatedText()).toBe("It began in the morning. Then we drove north.");
    expect(lines("[taos-translate-timing]")[0]).toMatch(/ chunks=2 chunk_fail=0 /);
  });

  it("a malformed prior is refused rather than half a turn translated as whole", async () => {
    const { POST } = await loadRoute();
    const res = await POST(request({ ...final, prior: "not json" }));
    expect(res.status).toBe(400);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("an auto turn with a hole: same direction either side stays one segment, marked in both languages", async () => {
    fetchSpy.mockImplementation(async (_url: unknown, init: RequestInit) => {
      const said = (JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> }).messages.find(
        (m) => m.role === "user"
      )?.content;
      return chat(JSON.stringify({ source_lang: "en", translation: said === "It began." ? "Empezó." : "y ahí termina" }));
    });
    const { POST } = await loadRoute();
    const res = await POST(
      request({
        sourceLanguage: "auto",
        targetLanguage: "auto",
        pairA: "en",
        pairB: "es",
        tone: "detailed",
        prior: serializePrior([{ text: "It began.", ms: 1 }, { text: null, ms: 45000 }]),
        chunk_index: "2",
        chunk_ms: "5000"
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.segments).toBeUndefined();
    expect(body.sourceLanguage).toBe("en");
    expect(body.original).toBe("It began. [audio lost 0:45] and that is where the story ends");
    expect(body.translation).toBe("Empezó. [audio perdido 0:45] y ahí termina");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("review: a long turn is kept as one file", () => {
  const part = { ...manual, chunk_part: "1", chunk_index: "0", chunk_ms: "270000", turn_id: TURN_ID };

  // These tests are about what is staged and kept when the build CAN join
  // chunks; whether this machine has an ffmpeg binary is not their subject
  // (the no-ffmpeg case has its own test below).
  beforeEach(() => {
    vi.doMock("@/lib/review/chunks", async (original) => ({
      ...(await original<typeof import("@/lib/review/chunks")>()),
      canKeepChunkedTurns: () => true
    }));
  });
  afterEach(() => {
    vi.doUnmock("@/lib/review/chunks");
  });

  it("nothing is staged for a speaker who has not opted in", async () => {
    const { POST } = await loadRoute();
    await POST(request(part));
    await Promise.all(waits);
    expect(bucket.size).toBe(0);
  });

  it("each part of an opted-in speaker's turn is staged under their own folder", async () => {
    speakerKeepsAudio.mockResolvedValue(true);
    const { POST } = await loadRoute();
    await POST(request(part));
    await POST(request({ ...part, chunk_index: "1" }));
    await Promise.all(waits);
    expect([...bucket.keys()].sort()).toEqual([`u1/parts/${TURN_ID}.0.webm`, `u1/parts/${TURN_ID}.1.webm`]);
  });

  it("a part whose transcription FAILED is staged too, so Redo can try it again", async () => {
    speakerKeepsAudio.mockResolvedValue(true);
    transcribeAudio.mockRejectedValue(new Error("Transcription failed"));
    const { POST } = await loadRoute();
    const res = await POST(request(part));
    await Promise.all(waits);
    expect(res.status).toBe(502);
    expect(bucket.has(`u1/parts/${TURN_ID}.0.webm`)).toBe(true);
  });

  it("the final request joins the staged parts with its own chunk, keeps ONE row, and clears the staging", async () => {
    speakerKeepsAudio.mockResolvedValue(true);
    const chunks = await import("@/lib/review/chunks");
    const { POST } = await loadRoute();
    await POST(request(part));
    await Promise.all(waits);
    const res = await POST(
      request({ ...manual, prior: serializePrior([{ text: "earlier", ms: 270000 }]), chunk_index: "1", chunk_ms: "60000", rec_ms: "330000", turn_id: TURN_ID })
    );
    const body = await res.json();
    await Promise.all(waits);
    expect(body.reviewId).toMatch(/^[0-9a-f-]{36}$/);
    // The 2000 zero bytes of the fixture are not audio (and this machine may
    // have no ffmpeg at all), so the join is refused and the turn is not
    // kept — but the staging is cleared either way.
    expect(keepTurnForReview).not.toHaveBeenCalled();
    expect(bucket.size).toBe(0);
    expect(chunks.reviewPartPath("u1", TURN_ID, 0, "audio/webm;codecs=opus")).toBe(`u1/parts/${TURN_ID}.0.webm`);
  });

  it("the kept row is the whole turn: joined audio, rec_ms of the turn, the stitched transcript", async () => {
    speakerKeepsAudio.mockResolvedValue(true);
    vi.doMock("@/lib/review/chunks", async (original) => ({
      ...(await original<typeof import("@/lib/review/chunks")>()),
      canKeepChunkedTurns: () => true,
      assembleReviewAudio: vi.fn(async (input: { priorCount: number; turnId: string }) => {
        expect(input).toMatchObject({ userId: "u1", turnId: TURN_ID, priorCount: 2, mime: "audio/webm" });
        return { bytes: new Uint8Array(4321), chunks: 3 };
      })
    }));
    try {
      const { POST } = await loadRoute();
      const res = await POST(
        request({
          ...manual,
          prior: serializePrior([
            { text: "one", ms: 270000 },
            { text: "two", ms: 270000 }
          ]),
          chunk_index: "2",
          chunk_ms: "60000",
          rec_ms: "600000",
          turn_id: TURN_ID
        })
      );
      const body = await res.json();
      await Promise.all(waits);
      expect(keepTurnForReview).toHaveBeenCalledTimes(1);
      const kept = keepTurnForReview.mock.calls[0][0] as Record<string, unknown>;
      expect(kept.id).toBe(body.reviewId);
      expect((kept.audio as Uint8Array).byteLength).toBe(4321);
      expect(kept.recMs).toBe(600000);
      expect(kept.originalText).toBe("one two and that is where the story ends");
      expect(kept.surface).toBe("home");
    } finally {
      vi.doUnmock("@/lib/review/chunks");
    }
  });

  it("no ffmpeg in the build: nothing staged, no row promised, and the log says why", async () => {
    speakerKeepsAudio.mockResolvedValue(true);
    vi.doMock("@/lib/review/chunks", async (original) => ({
      ...(await original<typeof import("@/lib/review/chunks")>()),
      canKeepChunkedTurns: () => false
    }));
    try {
      const { POST } = await loadRoute();
      await POST(request(part));
      const res = await POST(
        request({ ...manual, prior: serializePrior([{ text: "earlier", ms: 6000 }]), chunk_index: "1", chunk_ms: "6000", turn_id: TURN_ID })
      );
      await Promise.all(waits);
      expect(res.status).toBe(200);
      // No reviewId → the home card never offers a Redo that would 404.
      expect((await res.json()).reviewId).toBeUndefined();
      expect(bucket.size).toBe(0);
      expect(keepTurnForReview).not.toHaveBeenCalled();
      expect(lines("[taos-review]")).toEqual(["[taos-review] keep_skipped surface=home code=no_ffmpeg"]);
    } finally {
      vi.doUnmock("@/lib/review/chunks");
    }
  });

  it("an ordinary turn is kept exactly as before: its own audio, no staging", async () => {
    speakerKeepsAudio.mockResolvedValue(true);
    const { POST } = await loadRoute();
    await POST(request({ ...manual, rec_ms: "88000" }));
    await Promise.all(waits);
    expect(keepTurnForReview).toHaveBeenCalledTimes(1);
    const kept = keepTurnForReview.mock.calls[0][0] as Record<string, unknown>;
    expect((kept.audio as ArrayBuffer).byteLength).toBe(2000);
    expect(kept.recMs).toBe(88000);
    expect(bucket.size).toBe(0);
  });

  it.skipIf(!ffmpegPath())("real recordings join into one file that decodes to their combined length", async () => {
    const bin = ffmpegPath() as string;
    const tone = (hz: number) =>
      new Uint8Array(
        spawnSync(bin, ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=2`, "-c:a", "libopus", "-b:a", "32k", "-f", "webm", "-"], {
          maxBuffer: 1 << 24
        }).stdout
      );
    const { concatAudio } = await import("@/lib/review/chunks");
    const joined = await concatAudio([tone(440), tone(660), tone(880)], "audio/webm;codecs=opus");
    expect(joined).not.toBeNull();
    const probe = spawnSync(bin, ["-v", "error", "-i", "-", "-f", "f32le", "-ac", "1", "-ar", "8000", "-"], {
      input: joined as Uint8Array,
      maxBuffer: 1 << 26
    });
    const seconds = probe.stdout.byteLength / 4 / 8000;
    expect(seconds).toBeGreaterThan(5.8);
    expect(seconds).toBeLessThan(6.3);
  });

  it("without ffmpeg several parts cannot be one file — and one part needs none", async () => {
    const { concatAudio } = await import("@/lib/review/chunks");
    const a = new Uint8Array([1, 2, 3]);
    expect(await concatAudio([a], "audio/webm", null)).toBe(a);
    expect(await concatAudio([a, a], "audio/webm", null)).toBeNull();
    expect(await concatAudio([], "audio/webm", null)).toBeNull();
  });

  it("parts of a turn that never finished are swept after a day; fresh ones are left", async () => {
    const { sweepReviewParts, REVIEW_PART_MAX_AGE_MS } = await import("@/lib/review/chunks");
    const now = Date.parse("2026-11-16T12:00:00Z");
    bucket.set(`u1/parts/${TURN_ID}.0.webm`, { bytes: new Uint8Array(1), created_at: new Date(now - REVIEW_PART_MAX_AGE_MS - 1000).toISOString() });
    bucket.set(`u1/parts/${TURN_ID}.1.webm`, { bytes: new Uint8Array(1), created_at: new Date(now - 60000).toISOString() });
    bucket.set(`u1/whole-turn.webm`, { bytes: new Uint8Array(1), created_at: new Date(now - 10 * REVIEW_PART_MAX_AGE_MS).toISOString() });
    const result = await sweepReviewParts(now);
    expect(result).toMatchObject({ scanned: 2, removed: 1, error: null });
    expect([...bucket.keys()].sort()).toEqual([`u1/parts/${TURN_ID}.1.webm`, "u1/whole-turn.webm"]);
    // It rides the same daily cron as the row sweep, and the by-hand door.
    expect(readFileSync("app/api/walkie/sweep/route.ts", "utf8")).toContain("sweepReviewParts()");
    expect(readFileSync("app/api/review/sweep/route.ts", "utf8")).toContain("sweepReviewParts()");
  });

  it("Redo re-reads the whole kept file, so it has the time and the room for ten minutes", () => {
    const redo = readFileSync("app/api/review/redo/route.ts", "utf8");
    expect(Number(/export const maxDuration = (\d+)/.exec(redo)?.[1])).toBe(300);
    expect(redo).toContain("timeoutMs: REDO_TRANSCRIBE_TIMEOUT_MS");
    expect(redo).toContain("translateTimeoutFor(original.length, PARAPHRASE_TIMEOUT_MS)");
    // ~1,800 words of transcript must not be cut at the old 4,000 characters.
    expect(readFileSync("lib/review/capture.ts", "utf8")).toContain("const MAX_TEXT_CHARS = 16000;");
    expect(readFileSync("lib/review/store.ts", "utf8")).toContain("const MAX_REDO_TEXT_CHARS = 16000;");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("quota: a chunked turn is ONE translation", () => {
  const shell = readFileSync("components/TranslatorShell.tsx", "utf8");

  it("the unit is unchanged: rows saved by the finished turn, counted once", () => {
    // The free allowance counts taos_lite_translations rows. A long turn
    // saves exactly what a short one does — after its ONE translation.
    expect(shell.match(/saveTranslation\(/g)).toHaveLength(1);
    expect(shell).toContain("translations: (u?.translations ?? 0) + rows.length,");
  });

  it("a part saves nothing and counts nothing", () => {
    const fn = shell.slice(shell.indexOf("async function transcribePart("), shell.indexOf("async function handleRecordingStopped("));
    expect(fn).not.toContain("saveTranslation");
    expect(fn).not.toContain("setUsage");
  });

  it("a blocked trial still cannot start a turn of any length", () => {
    const start = shell.slice(shell.indexOf("async function startRecording()"), shell.indexOf("function finishRecordingUi()"));
    expect(start).toContain("if (trialBlocked) return;");
    expect(start.indexOf("if (trialBlocked) return;")).toBeLessThan(start.indexOf("getUserMedia"));
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("saying a long translation", () => {
  it("a line a five-minute turn produces is one call, exactly as before", () => {
    const line = "Una frase. ".repeat(300).trim(); // 3,299 chars
    expect(line.length).toBeLessThan(LONG_SPEECH_FROM_CHARS);
    expect(splitForSpeech(line)).toEqual([line]);
    expect(splitForSpeech("")).toEqual([]);
  });

  it("a ten-minute line is spoken in sentence-aligned pieces, every word once, in order", () => {
    const sentences = Array.from({ length: 400 }, (_, i) => `Esta es la frase número ${i}, y dice algo.`);
    const line = sentences.join(" ");
    const pieces = splitForSpeech(line);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(SPEECH_PIECE_MAX_CHARS);
      expect(piece.endsWith(".")).toBe(true);
    }
    expect(pieces.join(" ")).toBe(line);
  });

  it("one enormous sentence still splits, at spaces", () => {
    const pieces = splitForSpeech("palabra ".repeat(1500).trim());
    expect(pieces.length).toBeGreaterThan(1);
    expect(Math.max(...pieces.map((p) => p.length))).toBeLessThanOrEqual(SPEECH_PIECE_MAX_CHARS);
    expect(pieces.join(" ").split(" ")).toHaveLength(1500);
  });

  it("the home screen joins the pieces with the joiner a mixed turn already uses", () => {
    const shell = readFileSync("components/TranslatorShell.tsx", "utf8");
    expect(shell).toContain("const pieces = mixed ? [] : splitForSpeech(text);");
    expect(shell).toContain(": pieces.length > 1\n        ? speechForSegments(");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("the founder test knobs", () => {
  it("nobody but a founder can shorten a chunk or fail one", () => {
    expect(longTurnKnobs("?chunk=30&failchunk=2", false)).toEqual({ chunkMs: HOME_CHUNK_MS, failIndex: null });
    expect(longTurnKnobs("?chunk=30&failchunk=2", true)).toEqual({ chunkMs: 30000, failIndex: 1 });
    expect(longTurnKnobs("", true)).toEqual({ chunkMs: HOME_CHUNK_MS, failIndex: null });
  });

  it("a chunk can only be made SHORTER, and the turn cap is not a knob", () => {
    expect(longTurnKnobs("?chunk=9999", true).chunkMs).toBe(HOME_CHUNK_MS);
    expect(longTurnKnobs("?chunk=1", true).chunkMs).toBe(HOME_CHUNK_MS);
    expect(longTurnKnobs("?chunk=abc&failchunk=0", true)).toEqual({ chunkMs: HOME_CHUNK_MS, failIndex: null });
    expect(readFileSync("components/TranslatorShell.tsx", "utf8")).toContain(
      'longTurnKnobs(typeof window === "undefined" ? "" : window.location.search, founder)'
    );
  });
});
