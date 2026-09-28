// @vitest-environment jsdom
//
// The Gemini interpreter engine, driven through a fake socket: what a
// streaming translator's messages become on the /call screen, in the lag log,
// and in the cost log.
//
// The one promise this file exists to hold is the bake-off's: EVERY Gemini
// session that connected reports its spend when it stops — hang-up, idle,
// failure — because E8 found the OpenAI arm loses the calls that end badly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCallLagLog } from "@/lib/call/lag";
import type { InterpreterSessionReport } from "@/lib/call/interpreterEngine";

const bridge = {
  onChunk: null as ((pcm: Int16Array) => void) | null,
  track: null as unknown,
  released: 0
};

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" })
}));

vi.mock("@/lib/call/audioBridge", () => ({
  ensureCallAudioContext: () => ({}),
  bridgeInterpreterPcm: (track: unknown, onChunk: (pcm: Int16Array) => void) => {
    bridge.track = track;
    bridge.onChunk = onChunk;
    return { clockDriftMs: () => 0, level: () => 0.3, release: () => (bridge.released += 1) };
  }
}));

const pushed: boolean[] = [];
vi.mock("@/lib/call/pcmPlayer", () => ({
  createPcmPlayer: () => ({
    push: (_s: Float32Array, voiced: boolean) => pushed.push(voiced),
    setMuted: () => {},
    stats: () => ({ played: 0, droppedSilence: 0, droppedOverrun: 0, underruns: 0, aheadMs: 0 }),
    release: () => {}
  })
}));

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "blob";
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const fetchSpy = vi.fn(
  async (..._args: unknown[]) =>
    new Response(JSON.stringify({ wsUrl: "wss://fake/constrained", model: "m" }), { status: 200 })
);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date"]
  });
  FakeSocket.instances = [];
  pushed.length = 0;
  bridge.onChunk = null;
  bridge.track = null;
  bridge.released = 0;
  fetchSpy.mockClear();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function start(extra: Record<string, unknown> = {}) {
  const { startGeminiInterpreter } = await import("@/lib/call/interpreterGemini");
  const reports: InterpreterSessionReport[] = [];
  const heard: string[] = [];
  const done: string[] = [];
  const states: string[] = [];
  const lagLines: string[] = [];
  const lagLog = createCallLagLog({
    room: "AB123",
    pair: () => "es->en",
    engine: () => "gemini",
    send: async () => {},
    echo: (l) => lagLines.push(l),
    flushIntervalMs: 0
  });
  const inputTrack = { id: "partner-track" } as unknown as MediaStreamTrack;
  const it = await startGeminiInterpreter(
    { direction: { source: "es", target: "en" }, inputTrack, lag: lagLog.session(), ...extra },
    {
      onSessionReport: (r) => reports.push(r),
      onHeard: (t) => heard.push(t),
      onTranslationDone: (t) => done.push(t),
      onState: (s) => states.push(s)
    }
  );
  const ws = FakeSocket.instances[0];
  return { it, ws, reports, heard, done, states, lagLines, inputTrack };
}

function connect(ws: FakeSocket) {
  ws.onopen?.();
  ws.emit({ setupComplete: {} });
}

describe("the Gemini engine", () => {
  it("sends an empty setup — everything is in the token — and only the partner's audio", async () => {
    const { ws, inputTrack } = await start();
    connect(ws);
    expect(JSON.parse(ws.sent[0])).toEqual({ setup: {} });
    expect(bridge.track).toBe(inputTrack);
    bridge.onChunk?.(new Int16Array(1600).fill(8000));
    const audio = JSON.parse(ws.sent[1]);
    expect(audio.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(atob(audio.realtimeInput.audio.data).length).toBe(3200);
  });

  it("makes a heard line and a caption out of a stream with no turn events", async () => {
    const { ws, heard, done, lagLines, it: interp } = await start();
    connect(ws);
    for (let i = 0; i < 10; i++) bridge.onChunk?.(new Int16Array(1600).fill(8000));
    ws.emit({ serverContent: { inputTranscription: { text: "Hola, ¿cómo " } } });
    vi.advanceTimersByTime(100);
    // The translation starts while the partner is still talking.
    ws.emit({ serverContent: { outputTranscription: { text: "Hi, how" } } });
    vi.advanceTimersByTime(200);
    ws.emit({ serverContent: { inputTranscription: { text: "estás?" } } });
    vi.advanceTimersByTime(900);
    expect(heard).toEqual(["Hola, ¿cómo estás?"]);
    expect(done).toEqual([]);
    ws.emit({ serverContent: { outputTranscription: { text: " are you?" } } });
    vi.advanceTimersByTime(1400);
    expect(done).toEqual(["Hi, how are you?"]);

    const turn = lagLines.find((l) => l.includes(" turn "));
    expect(turn).toContain("engine=gemini");
    // Translation began before the heard line: wait_ms is negative.
    expect(turn).toMatch(/wait_ms=-\d+/);
    expect(turn).toMatch(/generation_ms=1\d\d\d/);
    expect(interp.spend().responses).toBe(1);
  });

  it("plays speech as speech and silence as silence", async () => {
    const { ws } = await start();
    connect(ws);
    const loud = new Uint8Array(1200);
    new DataView(loud.buffer).setInt16(0, 9000, true);
    const quiet = new Uint8Array(1200);
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
    ws.emit({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64(loud) } }] } } });
    ws.emit({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64(quiet) } }] } } });
    expect(pushed).toEqual([true, false]);
  });

  it("sums usage deltas into the spend", async () => {
    const { ws, it: interp } = await start();
    connect(ws);
    ws.emit({ usageMetadata: { promptTokenCount: 50, responseTokenCount: 50 } });
    ws.emit({ usageMetadata: { promptTokenCount: 50, responseTokenCount: 50 } });
    expect(interp.spend()).toMatchObject({ engine: "gemini", audioInTokens: 100, audioOutTokens: 100 });
  });

  it("reports on hang-up, even having translated nothing", async () => {
    const { ws, it: interp, reports } = await start();
    connect(ws);
    ws.emit({ usageMetadata: { promptTokenCount: 50, responseTokenCount: 50 } });
    vi.advanceTimersByTime(30_000);
    await interp.stop();
    expect(reports).toHaveLength(1);
    expect(reports[0].endedBy).toBe("hangup");
    expect(reports[0].spend.responses).toBe(0);
    expect(reports[0].spend.audioInTokens).toBe(50);
    expect(reports[0].seconds).toBeCloseTo(30, 0);
    expect(bridge.released).toBe(1);
  });

  it("reports when it stops itself for quiet", async () => {
    const { ws, reports } = await start();
    connect(ws);
    vi.advanceTimersByTime(2 * 60 * 1000 + 10);
    expect(reports).toHaveLength(1);
    expect(reports[0].endedBy).toBe("idle");
  });

  it("reports once, as an error, when it fails after connecting", async () => {
    const { ws, reports, states } = await start();
    connect(ws);
    // Four drops inside a minute is past the restart budget of three.
    for (let i = 0; i < 4; i++) {
      FakeSocket.instances[FakeSocket.instances.length - 1].onclose?.({
        code: 1011,
        reason: "internal"
      });
      if (i < 3) {
        await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(i + 2));
        connect(FakeSocket.instances[i + 1]);
      }
    }
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0].endedBy).toBe("error");
    expect(states).toContain("error");
  });

  it("does not report a session that never connected", async () => {
    const { reports, states } = await start();
    vi.advanceTimersByTime(16_000);
    expect(states).toContain("error");
    expect(reports).toHaveLength(0);
  });

  it("hands over on goAway without a hole: make before break", async () => {
    // Measured: goAway arrives nine minutes into every connection, with 50s
    // left. The old socket keeps hearing the partner until the new one is
    // ready, and keeps playing out for DRAIN_MS after.
    const { ws: old, it: interp, done } = await start();
    connect(old);
    old.emit({ goAway: { timeLeft: "50s" } });
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    const next = FakeSocket.instances[1];
    expect(old.closed).toBe(false);

    // Not ready yet: input still goes to the old one.
    bridge.onChunk?.(new Int16Array(1600));
    expect(old.sent.filter((s) => s.includes("realtimeInput"))).toHaveLength(1);

    connect(next);
    bridge.onChunk?.(new Int16Array(1600));
    expect(next.sent.filter((s) => s.includes("realtimeInput"))).toHaveLength(1);
    expect(old.sent.filter((s) => s.includes("realtimeInput"))).toHaveLength(1);

    // The old one finishes the sentence it was translating.
    old.emit({ serverContent: { outputTranscription: { text: "until tomorrow" } } });
    vi.advanceTimersByTime(1500);
    expect(done).toEqual(["until tomorrow"]);

    vi.advanceTimersByTime(4000);
    expect(old.closed).toBe(true);
    expect(next.closed).toBe(false);
    await interp.stop();
    expect(next.closed).toBe(true);
  });

  it("re-mints for a new TARGET, and ignores a new source (Gemini detects it)", async () => {
    const { ws, it: interp } = await start();
    connect(ws);
    interp.setDirection({ source: "it", target: "en" });
    expect(FakeSocket.instances).toHaveLength(1);
    interp.setDirection({ source: "it", target: "fr" });
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    const body = JSON.parse(String((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body));
    expect(body.target).toBe("fr");
    await interp.stop();
  });

  it("drops input audio rather than queue it behind a slow socket", async () => {
    const { ws } = await start();
    connect(ws);
    ws.bufferedAmount = 1_000_000;
    const before = ws.sent.length;
    bridge.onChunk?.(new Int16Array(1600));
    expect(ws.sent.length).toBe(before);
  });
});
