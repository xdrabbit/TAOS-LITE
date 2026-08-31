// @vitest-environment jsdom
//
// Which MICROPHONE the fallback records with — the layer-2 question.
//
// tests/fast-live-dictation-hook.test.ts proves the dead-graph watchdog fires
// and that the batch mic gets pressed. It mocks `useDictation` away, so it
// cannot see the thing this file exists for: WHAT the batch mic then records
// from. Until this round the answer was "the same MediaStream the streaming
// attempt just failed on", and that is a fallback with a hole in it.
//
// The hole, stated as the failure it produces. `micVerdict` rule 3 fires when
// chunks are arriving and every sample in them is zero. That rules out an
// AudioContext which never started (rule 2 catches those) — so the graph is
// running, and the silence entered it from the TRACK. A track that hands over
// zeroes is one that another app, an interruption, or iOS itself has taken
// the audio away from, and handing it to MediaRecorder records the same
// zeroes into a WAV. Both lanes dead, and what Tom sees is exactly what he
// reported on 8/31: button lit, timer counting, four seconds, nothing.
//
// So this file mounts the live hook with the REAL `useDictation` underneath
// it, fakes the two things a Node process cannot have (a Web Audio graph and
// a MediaRecorder), and asks the only question that matters: is the stream
// the recorder is built on a DIFFERENT OBJECT from the one that failed?
//
// Both branches are pinned, because "always ask for a new one" is the other
// wrong answer. A socket that fails has said nothing about the microphone,
// and on iOS a close/reopen cycle inside the same second is its own way to
// get a stream that records silence. Adopt when the mic is not the accused;
// re-acquire when it is.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { STREAM_MUTE_MS } from "@/lib/fast/dictation";
import type { MicCapture } from "@/lib/fast/micCapture";

// ── A microphone, as two fake objects ───────────────────────────────────────

interface FakeTrack {
  kind: string;
  readyState: string;
  onended: null | (() => void);
  stop: () => void;
}

interface FakeStream {
  id: string;
  tracks: FakeTrack[];
  getTracks: () => FakeTrack[];
  getAudioTracks: () => FakeTrack[];
}

/** Everything that happened, in order — the ordering IS part of the fix. */
let timeline: string[] = [];

function fakeStream(id: string): FakeStream {
  const track: FakeTrack = {
    kind: "audio",
    readyState: "live",
    onended: null,
    stop() {
      this.readyState = "ended";
      timeline.push(`stop:${id}`);
    }
  };
  const tracks = [track];
  return { id, tracks, getTracks: () => tracks, getAudioTracks: () => tracks };
}

/** The stream the STREAMING attempt opened, inside the tap. */
let streamed: FakeStream;
/** What a fresh getUserMedia hands back, one per call. */
let granted: FakeStream[] = [];
let getUserMedia: ReturnType<typeof vi.fn>;

// ── The audio graph, faked; micVerdict stays real ───────────────────────────

const mic = { frames: 0, voicedMs: 0, audibleMs: 0 };

const openMicCapture = vi.fn((_options: unknown): MicCapture => {
  let detached = false;
  return {
    started: Promise.resolve(),
    frames: () => mic.frames,
    voicedMs: () => mic.voicedMs,
    audibleMs: () => mic.audibleMs,
    toWav: () => new Blob(["riff"], { type: "audio/wav" }),
    stopRetaining: () => undefined,
    detachStream: () => {
      // The real one gives up ownership so close() leaves the tracks alone.
      detached = true;
      timeline.push("detach");
      return streamed as unknown as MediaStream;
    },
    close: () => {
      timeline.push("close");
      // The real MicCapture stops the tracks unless they were detached. That
      // is the behaviour the fix depends on, so the fake honours it exactly.
      if (!detached) streamed.getTracks().forEach((t) => t.stop());
    }
  };
});

vi.mock("@/lib/fast/micCapture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fast/micCapture")>();
  return { ...actual, openMicCapture: (o: unknown) => openMicCapture(o) };
});

vi.mock("@/lib/authClient", () => ({
  authHeaders: async () => ({ Authorization: "Bearer t" }),
  jsonAuthHeaders: async () => ({
    "Content-Type": "application/json",
    Authorization: "Bearer t"
  })
}));

/** A recogniser that starts, answers nothing, and closes politely. */
function fakeRecognizer() {
  return {
    set recognizing(_fn: never) {},
    set recognized(_fn: never) {},
    set canceled(_fn: never) {},
    startContinuousRecognitionAsync: (ok: () => void) => ok(),
    stopContinuousRecognitionAsync: (ok: () => void) => ok(),
    close: () => undefined
  };
}

vi.mock("microsoft-cognitiveservices-speech-sdk", () => ({
  SpeechConfig: { fromAuthorizationToken: () => ({ setProperty: () => undefined }) },
  AudioInputStream: { createPushStream: () => ({ write: () => undefined, close: () => undefined }) },
  AudioStreamFormat: { getWaveFormatPCM: () => ({}) },
  AudioConfig: { fromStreamInput: () => ({}) },
  AutoDetectSourceLanguageConfig: { fromLanguages: () => ({}) },
  PropertyId: { SpeechServiceConnection_LanguageIdMode: "lidmode" },
  ResultReason: { RecognizedSpeech: "RecognizedSpeech" },
  CancellationReason: { Error: "Error" },
  SpeechRecognizer: Object.assign(
    function SpeechRecognizer() {
      return fakeRecognizer();
    },
    { FromConfig: () => fakeRecognizer() }
  )
}));

// ── MediaRecorder, reduced to "which stream were you handed?" ───────────────

/** Every stream a MediaRecorder was constructed on, in order. */
let recorded: FakeStream[] = [];

class FakeMediaRecorder {
  static isTypeSupported = (): boolean => true;
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: null | ((e: { data: Blob }) => void) = null;
  onstop: null | (() => void) = null;
  onerror: null | (() => void) = null;
  constructor(public stream: FakeStream) {
    recorded.push(stream);
    timeline.push(`record:${stream.id}`);
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
    this.onstop?.();
  }
}

// ── Token minting, and the switch that makes it fail ────────────────────────

let mintOk = true;
const fetchSpy = vi.fn(async (url: string) => {
  if (String(url).includes("/api/fast/speech-settle")) {
    return new Response(JSON.stringify({ billedSeconds: 1, settled: true }), { status: 200 });
  }
  if (!mintOk) {
    // The shape a socket-side failure actually takes: an unconfigured or
    // unreachable Speech resource. `beginStream` rejects, nothing has been
    // learned about the microphone.
    return new Response(JSON.stringify({ error: "speech_unavailable" }), { status: 503 });
  }
  return new Response(
    JSON.stringify({
      token: "jwt",
      region: "eastus",
      expiresInMs: 600_000,
      sessionId: "spk-1",
      grantedSeconds: 30
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  timeline = [];
  recorded = [];
  granted = [fakeStream("fresh-1"), fakeStream("fresh-2")];
  streamed = fakeStream("gesture");
  mic.frames = 0;
  mic.voicedMs = 0;
  mic.audibleMs = 0;
  mintOk = true;
  openMicCapture.mockClear();
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;

  getUserMedia = vi.fn(async () => {
    const next = granted.shift();
    if (!next) throw new Error("the test ran out of microphones");
    timeline.push(`getUserMedia:${next.id}`);
    return next as unknown as MediaStream;
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia }
  });
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;

  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"]
  });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  vi.resetModules();
});

// ── Harness ─────────────────────────────────────────────────────────────────

async function mount() {
  const { useLiveDictation } = await import("@/lib/fast/useLiveDictation");
  const onAudio = vi.fn(async () => undefined);
  const onError = vi.fn();
  const view = renderHook(() =>
    useLiveDictation({
      candidates: ["en-US"],
      onSegment: vi.fn(),
      onAudio,
      onError
    })
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  return { ...view, onAudio, onError };
}

async function flush() {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

async function press(view: Awaited<ReturnType<typeof mount>>) {
  await act(async () => {
    view.result.current.press();
  });
  await flush();
}

/** Run the clock with the microphone dialled as it currently is. */
async function listen(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Frames climbing, every sample zero — Tom's symptom, at the track. */
async function deliverSilence() {
  for (let elapsed = 0; elapsed <= STREAM_MUTE_MS + 500; elapsed += 250) {
    mic.frames += 10;
    await listen(250);
  }
  await flush();
}

// ───────────────────────────────────────────────────────────────────────────

describe("a zero-filled track is not inherited by the fallback", () => {
  it("records from a NEW MediaStream, not the one that delivered the zeroes", async () => {
    const view = await mount();
    await press(view);
    expect(view.result.current.mode).toBe("stream");

    await deliverSilence();

    expect(view.result.current.mode).toBe("batch");
    // The whole point, in one line: a recorder was built, and not on the
    // stream that had just proved itself deaf.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).not.toBe(streamed);
    expect(recorded[0].id).toBe("fresh-1");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("stops the old tracks, and stops them BEFORE asking for new ones", async () => {
    // Two separate claims. Stopping at all is what drops the browser's
    // recording indicator and releases the device; stopping FIRST is what
    // gives the second getUserMedia a chance to come back with a different
    // capture rather than a second handle on the same held one.
    const view = await mount();
    await press(view);
    await deliverSilence();

    expect(streamed.tracks[0].readyState).toBe("ended");
    expect(timeline.indexOf("stop:gesture")).toBeGreaterThan(-1);
    expect(timeline.indexOf("stop:gesture")).toBeLessThan(timeline.indexOf("getUserMedia:fresh-1"));
    // And it was never handed on: `detachStream` is the adopt path, and this
    // press must not take it.
    expect(timeline).not.toContain("detach");
  });

  it("keeps the fallback fed even if the second getUserMedia is refused", async () => {
    // The honest failure. If iOS does re-prompt outside the gesture and the
    // answer is no — or the device is genuinely gone — the person must get a
    // sentence rather than a button that does nothing. This is the same
    // NotAllowedError path the very first dictation of a visit already used.
    granted = [];
    getUserMedia.mockImplementation(async () => {
      const denied = new Error("denied");
      denied.name = "NotAllowedError";
      throw denied;
    });
    const view = await mount();
    await press(view);
    await deliverSilence();

    expect(recorded).toHaveLength(0);
    expect(view.onError).toHaveBeenCalledWith(expect.stringContaining("Microphone access was denied"));
  });
});

describe("a socket that fails says nothing about the microphone", () => {
  it("adopts the already-open stream rather than opening a second one", async () => {
    // The other branch, and the reason this is not simply "always re-acquire".
    // The mint 503'd, so `beginStream` rejected before the capture was ever
    // judged: the tracks are known-good, already granted, and opened inside
    // the tap. Asking iOS for another one here would be the close/reopen
    // cycle that lib/fast/micCapture.ts warns about, for no evidence at all.
    mintOk = false;
    const view = await mount();
    await press(view);
    await flush();

    expect(view.result.current.mode).toBe("batch");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toBe(streamed);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(streamed.tracks[0].readyState).toBe("live");
  });
});
