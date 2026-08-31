// @vitest-environment jsdom
//
// The failure path, driven through the actual hook.
//
// The rest of this branch's 1000-odd tests could not see the bug it exists
// for, and the second review said so plainly. tests/fast-live-dictation.test.ts
// pins pure functions and reads source; tests/fast-mic-capture.test.ts pins
// `micVerdict` as a table of numbers. Both are worth having and neither one
// mounts `useLiveDictation`, so neither can answer the only question that
// matters about a watchdog: when it fires, does anything actually happen?
//
// That gap is exactly where the bug lived. `micVerdict` returning
// "dead-graph" is inert unless a running interval is reading it, unless
// `recoverToBatch` is wired to it, unless the batch mic gets pressed, and
// unless the reservation is settled on the way past. Four wires, none of them
// visible to a pure test.
//
// So this file mounts the hook against a fake microphone and a fake
// recogniser and walks the transition end to end. The mocks are the two
// things a Node process genuinely cannot have — a Web Audio graph and an
// Azure websocket. Everything between them is the shipped code.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  MIC_SILENT_MS,
  STREAM_DEAF_MS,
  STREAM_MUTE_MS,
  STREAM_NO_RESULT_MS
} from "@/lib/fast/dictation";
import type { MicCapture } from "@/lib/fast/micCapture";

// ── The fakes ───────────────────────────────────────────────────────────────

/** What the fake microphone is currently delivering. The dial this test turns. */
const mic = {
  frames: 0,
  voicedMs: 0,
  audibleMs: 0,
  closed: false,
  detached: false,
  retaining: true
};

const openMicCapture = vi.fn((_options: unknown): MicCapture => {
  return {
    started: Promise.resolve(),
    frames: () => mic.frames,
    voicedMs: () => mic.voicedMs,
    audibleMs: () => mic.audibleMs,
    toWav: () => new Blob(["riff"], { type: "audio/wav" }),
    stopRetaining: () => {
      mic.retaining = false;
    },
    detachStream: () => {
      mic.detached = true;
      return null;
    },
    close: () => {
      mic.closed = true;
    }
  };
});

// micVerdict stays REAL. It is the rule under test; only the graph is faked.
vi.mock("@/lib/fast/micCapture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fast/micCapture")>();
  return { ...actual, openMicCapture: (o: unknown) => openMicCapture(o) };
});

/** The batch mic, reduced to the one fact this file needs: was it pressed? */
const batch = { press: vi.fn(), release: vi.fn(), cancel: vi.fn(), state: "idle" as const };
vi.mock("@/lib/fast/useDictation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fast/useDictation")>();
  return {
    ...actual,
    useDictation: () => ({
      state: batch.state,
      latched: false,
      seconds: 0,
      press: batch.press,
      release: batch.release,
      cancel: batch.cancel
    })
  };
});

vi.mock("@/lib/authClient", () => ({
  authHeaders: async () => ({ Authorization: "Bearer t" }),
  jsonAuthHeaders: async () => ({
    "Content-Type": "application/json",
    Authorization: "Bearer t"
  })
}));

/** The recogniser's callbacks, captured so a test can be Azure for a moment. */
let handlers: {
  recognizing?: (s: unknown, e: { result: { text: string } }) => void;
  recognized?: (s: unknown, e: { result: { text: string; reason: string } }) => void;
  canceled?: (s: unknown, e: { reason: string; errorDetails?: string }) => void;
} = {};

const recognizerClosed = vi.fn();

function fakeRecognizer() {
  const recognizer = {
    set recognizing(fn: never) {
      handlers.recognizing = fn;
    },
    set recognized(fn: never) {
      handlers.recognized = fn;
    },
    set canceled(fn: never) {
      handlers.canceled = fn;
    },
    startContinuousRecognitionAsync: (ok: () => void) => ok(),
    stopContinuousRecognitionAsync: (ok: () => void) => ok(),
    close: recognizerClosed
  };
  return recognizer;
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

const settles: Array<Record<string, unknown>> = [];
/** Every speech-token body, so a test can see which presses asked to REUSE. */
const mints: Array<Record<string, unknown>> = [];
const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
  if (String(url).includes("/api/fast/speech-settle")) {
    settles.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ billedSeconds: 1, settled: true }), { status: 200 });
  }
  mints.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
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
  mic.frames = 0;
  mic.voicedMs = 0;
  mic.audibleMs = 0;
  mic.closed = false;
  mic.detached = false;
  mic.retaining = true;
  handlers = {};
  settles.length = 0;
  mints.length = 0;
  openMicCapture.mockClear();
  recognizerClosed.mockClear();
  batch.press.mockClear();
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"]
  });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
  vi.resetModules();
});

// ── The harness ─────────────────────────────────────────────────────────────

async function mount() {
  const { useLiveDictation } = await import("@/lib/fast/useLiveDictation");
  const onSegment = vi.fn();
  const onAudio = vi.fn(async () => undefined);
  const onError = vi.fn();
  const view = renderHook(() =>
    useLiveDictation({
      // One locale, so the recogniser takes the simple constructor path.
      candidates: ["en-US"],
      onSegment,
      onAudio,
      onError
    })
  );
  // Let the clock leave zero before anything is pressed. `performance.now()`
  // is faked here and starts at 0, which a browser's never is — and the hook
  // stores the press timestamp with `pressedAtRef.current || performance.now()`,
  // so a press at exactly zero would read as "no press recorded".
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  return { ...view, onSegment, onAudio, onError };
}

/**
 * Drain everything queued: microtasks, the SDK's dynamic import, the mint
 * round trip. Several rounds because they are chained, not parallel.
 */
async function flush() {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

/** Press, and let the socket finish opening. */
async function press(view: Awaited<ReturnType<typeof mount>>) {
  await act(async () => {
    view.result.current.press();
  });
  await flush();
}

/** Let the watchdog run for a while with the microphone as currently dialled. */
async function listen(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// ───────────────────────────────────────────────────────────────────────────

describe("useLiveDictation — a press that opens a real socket", () => {
  it("streams, and stays streaming while Azure is answering", async () => {
    // The control. Without it a test that only ever sees a fallback would
    // pass just as well against a hook that never streams at all.
    const view = await mount();
    await press(view);
    expect(view.result.current.mode).toBe("stream");
    expect(view.result.current.state).toBe("recording");

    mic.frames = 40;
    mic.audibleMs = 900;
    mic.voicedMs = 800;
    act(() => {
      handlers.recognizing?.(null, { result: { text: "where is" } });
    });
    // Comfortably inside the thirty-second utterance cap, which would stop
    // the stream and clear the tail for a reason that is not this test's.
    await listen(5_000);

    expect(view.result.current.mode).toBe("stream");
    expect(view.result.current.partial).toBe("where is");
    expect(batch.press).not.toHaveBeenCalled();
    // One hypothesis is proof the graph runs and the socket is two-way, so
    // the retained copy is dropped the moment it arrives.
    expect(mic.retaining).toBe(false);
  });
});

describe("useLiveDictation — the dead graph actually falls back", () => {
  it("hands a graph that delivered nothing to the batch mic", async () => {
    // The iPhone case from #50: an AudioContext built outside the tap stays
    // suspended, so no PCM is ever produced. Azure hears digital silence on a
    // continuous session and emits no partial, no final and no cancellation.
    // Nothing throws, so before the watchdog nothing fell back — the button
    // simply stayed lit forever.
    const view = await mount();
    await press(view);
    expect(view.result.current.mode).toBe("stream");

    mic.frames = 0;
    await listen(MIC_SILENT_MS + 500);

    expect(view.result.current.mode).toBe("batch");
    expect(batch.press).toHaveBeenCalledTimes(1);
  });

  it("catches Tom's 8/31 symptom: lit, counting, connected, and carrying zeroes", async () => {
    // THE test this branch was missing. Here the audio graph IS running —
    // `frames` climbs the whole time, the timer counts, the recogniser is
    // started and the socket is open — and every chunk is silence. The old
    // `frames === 0` fence reads that as a healthy microphone and waits
    // forever, which is precisely the field report.
    const view = await mount();
    await press(view);

    // A running graph, delivering. And carrying nothing.
    for (let elapsed = 0; elapsed < STREAM_MUTE_MS - 500; elapsed += 250) {
      mic.frames += 10;
      await listen(250);
    }
    // Still streaming: chunks are arriving, and it is too early to judge.
    expect(view.result.current.mode).toBe("stream");
    expect(mic.frames).toBeGreaterThan(0);

    await listen(1000);

    expect(view.result.current.mode).toBe("batch");
    expect(batch.press).toHaveBeenCalledTimes(1);
  });

  it("settles the reservation on the way out, rather than leaving it to the reaper", async () => {
    // A fallback is still an utterance that started. Leaving the hold open
    // would bill the full thirty-second grant for a mic that produced nothing
    // — and would hold down the hourly budget until the next press.
    const view = await mount();
    await press(view);
    mic.frames = 0;
    await listen(MIC_SILENT_MS + 500);

    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ sessionId: "spk-1" });
  });

  it("does NOT carry the accused microphone across — it closes it", async () => {
    // ── Reversed on purpose, 8/31 round 3. ──────────────────────────────
    // This used to pin the opposite: "carries the already-granted microphone
    // across instead of asking twice", on the grounds that a close/reopen
    // cycle inside the same second is how iOS gives you a stream that records
    // silence, and that a second getUserMedia would land outside the gesture.
    // The first half is true and the conclusion still does not follow, which
    // is why the old reasoning is kept here rather than deleted.
    //
    // This fallback fires BECAUSE the audio was silent. If the zeroes are
    // coming from the track rather than from the AudioContext, handing that
    // track to MediaRecorder records the same zeroes — a fallback that
    // inherits the fault, and Tom's exact symptom either way round. The
    // capture is closed instead (which stops its tracks) and useDictation
    // opens its own.
    //
    // What that costs, and why it is affordable, is written out at
    // `discardCapture` in lib/fast/useLiveDictation.ts. That the batch mic
    // then records from a DIFFERENT stream object is proved end to end, with
    // the real useDictation underneath, in tests/fast-mic-fresh-stream.ts —
    // this file mocks that hook away and so cannot see it.
    const view = await mount();
    await press(view);
    mic.frames = 0;
    await listen(MIC_SILENT_MS + 500);

    expect(mic.detached).toBe(false);
    expect(mic.closed).toBe(true);
    expect(openMicCapture).toHaveBeenCalledTimes(1);
  });

  it("still hands the microphone on when it was the SOCKET that failed", async () => {
    // The other branch, so that "never adopt" cannot quietly become the rule.
    // A mint that 503s says nothing about the microphone: those tracks are
    // granted, open, and were opened inside the tap.
    fetchSpy.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: "speech_unavailable" }), { status: 503 })
    );
    const view = await mount();
    await press(view);

    expect(view.result.current.mode).toBe("batch");
    expect(mic.detached).toBe(true);
    expect(batch.press).toHaveBeenCalledTimes(1);
  });

  it("backstops a trickle of signal that never becomes a word", async () => {
    // Neither zero nor speech: a DC offset, or dither. Rule 3 lets it past
    // and rule 4 never fires, so without the backstop this is the wait-
    // forever case wearing a different hat.
    const view = await mount();
    await press(view);

    mic.frames = 10;
    mic.audibleMs = 200;
    await listen(STREAM_DEAF_MS + 1000);
    expect(view.result.current.mode).toBe("stream");

    mic.frames = 400;
    mic.audibleMs = 11_000;
    await listen(STREAM_NO_RESULT_MS);

    expect(view.result.current.mode).toBe("batch");
    expect(batch.press).toHaveBeenCalledTimes(1);
  });
});

describe("useLiveDictation — a dropped socket does not cost a live-token slot", () => {
  /** Azure's way of saying the socket died: a cancellation with reason Error. */
  async function dropTheSocket() {
    await act(async () => {
      handlers.canceled?.(null, { reason: "Error", errorDetails: "connection closed" });
      await vi.advanceTimersByTimeAsync(1);
    });
  }

  it("keeps the credential after one bad socket, and re-reserves against it", async () => {
    // The other half of the slot leak the second review found, and this half
    // lives in the browser. Dropping the token here does not retire it —
    // Azure has no revocation — it just makes the next press mint a SECOND
    // one, and spends another of the six slots. A tunnel, a captive portal or
    // a walk out of range would do that once per press until the ceiling
    // refuses, at which point the streaming mic goes quietly lumpy for ten
    // minutes and the mic is not what is wrong.
    const view = await mount();
    await press(view);
    expect(mints[0]).toMatchObject({ reuse: false });

    await dropTheSocket();
    expect(view.onError).toHaveBeenCalledWith("Lost the mic — tap to try again.");

    await press(view);
    expect(mints).toHaveLength(2);
    expect(mints[1]).toMatchObject({ reuse: true });
  });

  it("gives up on a credential that fails twice with nothing heard in between", async () => {
    // The case where the token really is the suspect — a rotated key, a
    // credential minted against the wrong region. One strike is weather; two
    // in a row, with not one hypothesis between them, is the credential.
    const view = await mount();
    await press(view);
    await dropTheSocket();
    await press(view);
    await dropTheSocket();
    await press(view);

    expect(mints.map((m) => m.reuse)).toEqual([false, true, false]);
  });

  it("forgives a credential the moment Azure says anything through it", async () => {
    // A token that produced a hypothesis is a good token, so a socket that
    // dies later starts the count again rather than continuing it.
    const view = await mount();
    await press(view);
    await dropTheSocket();
    await press(view);
    act(() => {
      handlers.recognizing?.(null, { result: { text: "hola" } });
    });
    await dropTheSocket();
    await press(view);

    expect(mints.map((m) => m.reuse)).toEqual([false, true, true]);
  });
});

describe("useLiveDictation — the deaf socket keeps the recording", () => {
  it("salvages real speech rather than asking somebody to say it again", async () => {
    // Audio is flowing and somebody is talking into it, and Azure has said
    // nothing back. The graph is fine, so re-opening the mic would throw away
    // a transcription that is already captured — this path uploads it.
    const view = await mount();
    await press(view);

    mic.frames = 200;
    mic.audibleMs = 5000;
    mic.voicedMs = STREAM_DEAF_MS + 100;
    await listen(1000);

    // Relabelled as the lumpy mic, without the batch hook's press: the audio
    // is already in hand.
    expect(view.result.current.mode).toBe("batch");
    expect(batch.press).not.toHaveBeenCalled();

    await act(async () => {
      view.result.current.release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.onAudio).toHaveBeenCalledTimes(1);
  });
});
