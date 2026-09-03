// What the interpreter is actually listening to, and whether it can say so.
//
// Field report 2026-09-03, two iPhones on Safari, Wi-Fi ↔ cellular: both
// people heard each other's real voice perfectly, both interpreters minted
// and connected — and neither translated a single word. No responses, no
// usage POST, no error. Just dead air until the idle timer.
//
// The call handed the track it RECEIVED from the call peer connection
// straight to `addTrack` on the interpreter's peer connection, and WebKit
// sends silence when a received track is re-sent that way. Nothing throws;
// server VAD simply never commits anything, and with `create_response: false`
// there is nothing to respond to, forever.
//
// Two things are pinned here. First, the fix: the track handed to the session
// is one the AudioContext MADE, not the one it was given — a source-grep
// cannot tell those apart, because both are a call to `addTrack` with a
// track in it. Second, the telemetry, because the cause above is inferred
// from the symptom and not measured on the phone. A connected interpreter
// that hears nothing must now say the number out loud rather than looking
// exactly like a quiet room.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Nothing here reaches the TTS service; it is mocked so that the module
// under test can be imported at all.
const requestSpeech = vi.fn();
vi.mock("@/lib/tts/speech", () => ({
  requestSpeech: (...args: unknown[]) => requestSpeech(...args),
  isTextOnlyLanguage: () => false,
  TEXT_ONLY_TITLE: "Text only"
}));

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

// ── A browser, in the shape these two modules use one ──────────────────────

interface FakeTrack {
  kind: string;
  id: string;
  readyState: string;
  stop: ReturnType<typeof vi.fn>;
}

function makeTrack(id: string): FakeTrack {
  return { kind: "audio", id, readyState: "live", stop: vi.fn() };
}

let partnerTrack: FakeTrack;
let bridgedTrack: FakeTrack;
let sourceDisconnect: ReturnType<typeof vi.fn>;
let destinationDisconnect: ReturnType<typeof vi.fn>;
/** Streams handed to `createMediaStreamSource` — proof of WHAT was bridged. */
let bridgedFrom: unknown[];
let ctxResumes: number;

let addedTracks: Array<{ track: unknown; stream: unknown }>;
let peer: {
  connectionState: string;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((ev: unknown) => void) | null;
} | null = null;
let stats: Array<Record<string, unknown>>;
let dataChannel: {
  readyState: string;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  requestSpeech.mockClear();
  partnerTrack = makeTrack("partner");
  bridgedTrack = makeTrack("bridged");
  sourceDisconnect = vi.fn();
  destinationDisconnect = vi.fn();
  bridgedFrom = [];
  ctxResumes = 0;
  addedTracks = [];
  stats = [];
  peer = null;
  dataChannel = {
    readyState: "open",
    onmessage: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn()
  };

  const g = globalThis as Record<string, unknown>;
  g.document = {
    createElement: () => ({
      muted: false,
      autoplay: false,
      src: "",
      srcObject: null,
      style: {} as Record<string, string>,
      onended: null,
      onerror: null,
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      load: vi.fn(),
      remove: vi.fn(),
      removeAttribute: vi.fn()
    }),
    body: { appendChild: vi.fn() }
  };
  g.MediaStream = class {
    constructor(public tracks: unknown[] = []) {}
    getAudioTracks() {
      return this.tracks;
    }
    getTracks() {
      return this.tracks;
    }
  };
  g.AudioContext = class {
    state = "running";
    createMediaStreamSource(stream: unknown) {
      bridgedFrom.push(stream);
      return { connect: vi.fn(), disconnect: sourceDisconnect };
    }
    createMediaStreamDestination() {
      return {
        disconnect: destinationDisconnect,
        stream: {
          getAudioTracks: () => [bridgedTrack],
          getTracks: () => [bridgedTrack]
        }
      };
    }
    async resume() {
      ctxResumes += 1;
    }
    async close() {}
  };
  g.RTCPeerConnection = class {
    onconnectionstatechange: (() => void) | null = null;
    ontrack: ((ev: unknown) => void) | null = null;
    connectionState = "new";
    constructor() {
      peer = this;
    }
    createDataChannel() {
      return dataChannel;
    }
    addTrack(track: unknown, stream: unknown) {
      addedTracks.push({ track, stream });
    }
    async getStats() {
      return new Map(stats.map((s, i) => [`s${i}`, s]));
    }
    async createOffer() {
      return { type: "offer", sdp: "v=0" };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
    getSenders() {
      return [];
    }
  };
  g.window = globalThis;

  globalThis.fetch = vi.fn(async (input: unknown) => {
    if (String(input).includes("/api/call/realtime")) {
      return new Response(
        JSON.stringify({
          clientSecret: "ek_test",
          callUrl: "https://api.openai.com/v1/realtime/calls?model=gpt-realtime",
          model: "gpt-realtime",
          voice: "marin",
          mode: "clone"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("v=0\r\n", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
});

async function startInterpreter(events: Record<string, unknown> = {}) {
  const { startCallInterpreter } = await import("@/lib/call/interpreter");
  return startCallInterpreter(
    {
      direction: { source: "es", target: "en" },
      inputTrack: partnerTrack as unknown as MediaStreamTrack,
      voiceMode: "clone"
    },
    events
  );
}

/** Bring the session up to `connected`, which is what starts the polling. */
function connect(): void {
  if (!peer) throw new Error("no peer connection was built");
  peer.connectionState = "connected";
  peer.onconnectionstatechange?.();
}

function event(payload: Record<string, unknown>): void {
  dataChannel.onmessage?.({ data: JSON.stringify(payload) });
}

/** A `media-source` entry, as Chrome and modern Safari report one. */
function audioSource(level: number, energy: number): Record<string, unknown> {
  return { type: "media-source", kind: "audio", audioLevel: level, totalAudioEnergy: energy };
}

describe("the track the interpreter session is given", () => {
  it("is one the AudioContext made, not the one the call received", async () => {
    await startInterpreter();

    expect(addedTracks).toHaveLength(1);
    // The whole bug in one assertion: the partner's own track never reaches
    // the second peer connection, because Safari will not send it there.
    expect(addedTracks[0].track).toBe(bridgedTrack);
    expect(addedTracks[0].track).not.toBe(partnerTrack);
    // …and what the graph is carrying is that same partner audio.
    expect((bridgedFrom[0] as { tracks: unknown[] }).tracks).toEqual([partnerTrack]);
  });

  it("falls back to the raw track where there is no WebAudio", async () => {
    delete (globalThis as Record<string, unknown>).AudioContext;
    const onDiagnostic = vi.fn();
    await startInterpreter({ onDiagnostic });

    // Half an interpreter beats none: a browser with no AudioContext is not
    // a browser with this bug. But it says so, rather than looking identical.
    expect(addedTracks[0].track).toBe(partnerTrack);
    expect(onDiagnostic.mock.calls.map((c) => String(c[0])).join(" ")).toContain(
      "bridge unavailable"
    );
  });

  it("releases the graph at hang-up and leaves the partner's track running", async () => {
    const interpreter = await startInterpreter();
    connect();
    await interpreter.stop();

    expect(sourceDisconnect).toHaveBeenCalled();
    expect(destinationDisconnect).toHaveBeenCalled();
    // The bridged track was minted here, so stopping it costs nobody anything.
    expect(bridgedTrack.stop).toHaveBeenCalled();
    // The partner's track belongs to the call and is still carrying their
    // actual voice to the human listener. Stopping it would end the call.
    expect(partnerTrack.stop).not.toHaveBeenCalled();
  });

  it("stops polling once it has stopped", async () => {
    const onDiagnostic = vi.fn();
    stats = [audioSource(0.02, 0.9)];
    const interpreter = await startInterpreter({ onDiagnostic });
    connect();
    await vi.advanceTimersByTimeAsync(4000);
    const before = onDiagnostic.mock.calls.length;

    await interpreter.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onDiagnostic.mock.calls.length).toBe(before);
  });
});

describe("what the interpreter says it is hearing", () => {
  it("puts the input level on the trail", async () => {
    stats = [audioSource(0.031, 1.2)];
    const onDiagnostic = vi.fn();
    await startInterpreter({ onDiagnostic });
    connect();
    await vi.advanceTimersByTimeAsync(0);

    const lines = onDiagnostic.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("interp in level=0.031"))).toBe(true);
    expect(lines.some((l) => l.includes("energy=1.20"))).toBe(true);
  });

  it("counts the speech segments for the hang-up report", async () => {
    stats = [audioSource(0.04, 2.5)];
    const interpreter = await startInterpreter();
    connect();
    event({ type: "input_audio_buffer.speech_started", audio_start_ms: 100 });
    event({ type: "input_audio_buffer.committed" });
    event({ type: "input_audio_buffer.speech_started", audio_start_ms: 900 });
    await vi.advanceTimersByTimeAsync(0);

    const heard = interpreter.inputStats();
    expect(heard.speechStarted).toBe(2);
    expect(heard.speechCommitted).toBe(1);
    expect(heard.bridged).toBe(true);
    expect(heard.level).toBe(0.04);
  });

  it("says so when it has been connected for 20s and heard nothing", async () => {
    // Silence on the wire: a track that is sending empty frames. Cumulative
    // energy is what separates that from a room where nobody has spoken YET.
    stats = [audioSource(0, 0)];
    const onInputSilent = vi.fn();
    await startInterpreter({ onInputSilent });
    connect();

    await vi.advanceTimersByTimeAsync(18_000);
    expect(onInputSilent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6000);
    expect(onInputSilent).toHaveBeenCalledTimes(1);

    // Once, not every two seconds for the rest of the call.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onInputSilent).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the session is hearing speech", async () => {
    stats = [audioSource(0, 0)];
    const onInputSilent = vi.fn();
    await startInterpreter({ onInputSilent });
    connect();
    event({ type: "input_audio_buffer.speech_started", audio_start_ms: 100 });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onInputSilent).not.toHaveBeenCalled();
  });

  it("never accuses a browser that reports no numbers at all", async () => {
    // Older WebKit publishes neither audioLevel nor totalAudioEnergy. That is
    // an absent measurement, not a silent one, and it must not raise an alarm
    // on a call that is working perfectly well.
    stats = [];
    const onInputSilent = vi.fn();
    await startInterpreter({ onInputSilent });
    connect();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onInputSilent).not.toHaveBeenCalled();
  });
});
