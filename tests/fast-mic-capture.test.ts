// The microphone on /fast, and the iPhone rule it was breaking.
//
// tests/fast-live-dictation.test.ts pins the STREAMING contract — what a
// partial may cost, what a fallback may say, who may mint a token. It reads
// the hook as source, which is the right tool for a rule about intent and the
// wrong one for this bug: the mic was dead on an iPhone because of the ORDER
// three calls were made in, and no amount of reading a file proves an order.
//
// So this file runs lib/fast/micCapture.ts for real, against a fake Web Audio
// that behaves the way WebKit does, and asserts on numbers:
//
//   1. the AudioContext is constructed, resumed and handed getUserMedia
//      SYNCHRONOUSLY — before openMicCapture returns, with no await in front
//      of any of them. That single ordering IS the fix;
//   2. a context that stays suspended — WebKit's answer to one built outside
//      the tap — delivers zero PCM chunks, which is the signal the old mic
//      did not have and the reason it hung lit and silent forever;
//   3. micVerdict turns those counters into the fallback the field report
//      needed: dead graph, deaf socket, or leave it alone;
//   4. what comes out is 16 kHz mono 16-bit PCM, and the salvage copy is a
//      WAV a transcriber will actually accept.
//
// ── What this canNOT prove ─────────────────────────────────────────────────
// That real Mobile Safari honours the gesture. No engine available to CI is
// Mobile WebKit — a desktop WebKit build does not enforce the iOS audio
// session rules, and Playwright disables the autoplay policy that would be the
// closest analogue anyway. What is provable here is that the code makes the
// three calls in the order iOS requires, and that every silent-failure path
// now ends in the batch mic instead of nothing. The last leg is Tom's phone,
// and docs/fast-engine.md carries the checklist for it.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  micVerdict,
  openMicCapture,
  SPEECH_SAMPLE_RATE,
  type MicCapture
} from "@/lib/fast/micCapture";
import {
  MIC_SILENT_MS,
  STREAM_DEAF_MS,
  STREAM_MUTE_MS,
  STREAM_NO_RESULT_MS
} from "@/lib/fast/dictation";

// ───────────────────────────────────────────────────────────────────────────
// A Web Audio that can be told to behave like an iPhone
// ───────────────────────────────────────────────────────────────────────────

interface FakeOptions {
  /** WebKit's answer to a context built outside a gesture: it never runs. */
  staysSuspended?: boolean;
  /** The hardware rate. iOS runs its capture session at 48 kHz. */
  sampleRate?: number;
  /** Refuse the microphone, the way a denied permission does. */
  denyMic?: boolean;
  /** No AudioWorklet at all, so the ScriptProcessor path is exercised. */
  noWorklet?: boolean;
}

interface Rig {
  /** Every gesture-sensitive call, in the order it was made. */
  calls: string[];
  /** What `new AudioContext(...)` was actually given. */
  ctorArgs: unknown[];
  /** Push one frame of float samples through the graph. */
  emit: (frame: Float32Array) => void;
  tracksStopped: () => number;
  contextClosed: () => boolean;
}

let rig: Rig;

function installFakeAudio(options: FakeOptions = {}): Rig {
  const { staysSuspended = false, sampleRate = 48000, denyMic = false, noWorklet = false } = options;
  const calls: string[] = [];
  const ctorArgs: unknown[] = [];
  let deliver: ((frame: Float32Array) => void) | null = null;
  let tracksStopped = 0;
  let contextClosed = false;

  class FakeAudioContext {
    public state = "suspended";
    public sampleRate = sampleRate;
    public destination = { kind: "destination" };
    public audioWorklet = noWorklet
      ? undefined
      : {
          addModule: (url: string) => {
            calls.push(`addModule:${url.startsWith("blob:") ? "blob" : url}`);
            return Promise.resolve();
          }
        };
    constructor(...args: unknown[]) {
      calls.push("new AudioContext");
      ctorArgs.push(...args);
    }
    resume(): Promise<void> {
      calls.push("resume");
      // The bug, exactly: WebKit RESOLVES this outside a gesture and leaves
      // the context stopped. It does not throw, which is why nothing fell back.
      if (!staysSuspended) this.state = "running";
      return Promise.resolve();
    }
    close(): Promise<void> {
      contextClosed = true;
      return Promise.resolve();
    }
    createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
      return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
    }
    createScriptProcessor(): Record<string, unknown> {
      const node: Record<string, unknown> = {
        onaudioprocess: null,
        connect: () => undefined,
        disconnect: () => undefined
      };
      if (!staysSuspended) {
        deliver = (frame) => {
          const handler = node.onaudioprocess as
            | ((ev: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
            | null;
          handler?.({ inputBuffer: { getChannelData: () => frame } });
        };
      }
      return node;
    }
  }

  class FakeAudioWorkletNode {
    public port: { onmessage: ((ev: { data: Float32Array }) => void) | null } = {
      onmessage: null
    };
    constructor() {
      // A suspended context never pulls the graph, so `process` never runs and
      // nothing is ever posted. That is the whole iPhone failure in one line.
      if (!staysSuspended) {
        deliver = (frame) => this.port.onmessage?.({ data: frame });
      }
    }
    connect(): void {}
    disconnect(): void {}
  }

  const track = {
    stop: () => {
      tracksStopped++;
    }
  };
  const stream = { getTracks: () => [track] };

  const win = {
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () => {
        calls.push("getUserMedia");
        return denyMic
          ? Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }))
          : Promise.resolve(stream);
      }
    }
  });
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => "blob:fake",
    revokeObjectURL: () => undefined
  });

  return {
    calls,
    ctorArgs,
    emit: (frame) => deliver?.(frame),
    tracksStopped: () => tracksStopped,
    contextClosed: () => contextClosed
  };
}

/** A frame of loud audio — well past the voiced threshold. */
function speech(samples: number): Float32Array {
  const frame = new Float32Array(samples);
  for (let i = 0; i < samples; i++) frame[i] = Math.sin(i / 4) * 0.5;
  return frame;
}

/** A frame of near-silence — a quiet room, not a voice. */
function roomTone(samples: number): Float32Array {
  return new Float32Array(samples); // all zeroes
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ───────────────────────────────────────────────────────────────────────────
// 1. The gesture — the fix itself
// ───────────────────────────────────────────────────────────────────────────

describe("openMicCapture — everything iOS measures happens in the tap", () => {
  beforeEach(() => {
    rig = installFakeAudio();
  });

  it("builds the context, resumes it and asks for the mic before it returns", () => {
    // THE regression test. iOS only honours these inside the gesture's own
    // task, and the old mic reached all three from inside the Speech SDK,
    // after `await ensureWarm()` — one network round trip too late. The
    // assertion is deliberately made on the line AFTER the call, with nothing
    // awaited in between, because that is precisely what the phone checks.
    const capture = openMicCapture({ onPcm: () => undefined });

    expect(rig.calls).toEqual(["new AudioContext", "resume", "getUserMedia"]);
    capture.close();
  });

  it("does not ask the phone for a 16 kHz context", () => {
    // The SDK asks for `new AudioContext({ sampleRate: 16000 })`. iOS runs its
    // capture session at the hardware rate, and a graph built at a rate the
    // session is not running at is a second, separate silence bug. Take what
    // the phone gives and resample on the way out.
    openMicCapture({ onPcm: () => undefined }).close();
    expect(rig.ctorArgs).toEqual([]);
  });

  it("is not an async function, because an async function would be too late", () => {
    // A handle with a promise ON it, rather than a promise OF a handle: the
    // moment this becomes `async`, the three calls above move behind a
    // microtask and the bug comes back invisibly.
    const capture = openMicCapture({ onPcm: () => undefined });
    expect(typeof capture.frames).toBe("function");
    expect(capture.started).toBeInstanceOf(Promise);
    capture.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The signal the old mic did not have
// ───────────────────────────────────────────────────────────────────────────

describe("a suspended context is a mic that hears nothing", () => {
  it("delivers zero frames when WebKit leaves the context stopped", async () => {
    // The iPhone signature, reproduced: resume() resolves, the graph is wired,
    // nothing throws, and no audio is ever produced. `frames()` staying at 0
    // is the only observable difference between this and a working mic — and
    // it is what the watchdog reads.
    rig = installFakeAudio({ staysSuspended: true });
    const chunks: ArrayBuffer[] = [];
    const capture = openMicCapture({ onPcm: (c) => chunks.push(c) });
    await capture.started;

    rig.emit(speech(4096)); // the graph is dead: this goes nowhere
    expect(capture.frames()).toBe(0);
    expect(chunks).toHaveLength(0);
    capture.close();
  });

  it("delivers frames when the context actually runs", async () => {
    rig = installFakeAudio();
    const chunks: ArrayBuffer[] = [];
    const capture = openMicCapture({ onPcm: (c) => chunks.push(c) });
    await capture.started;

    rig.emit(speech(4800));
    expect(capture.frames()).toBe(1);
    expect(chunks).toHaveLength(1);
    capture.close();
  });

  it("rejects when the microphone is refused, so the batch mic can say so", async () => {
    // A denied permission must still THROW — that is fallback path 1, and the
    // batch mic is the thing that puts the denial into words.
    rig = installFakeAudio({ denyMic: true });
    const capture = openMicCapture({ onPcm: () => undefined });
    await expect(capture.started).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. The fallback rule, with numbers on it
// ───────────────────────────────────────────────────────────────────────────

describe("micVerdict — the failures that never threw", () => {
  it("keeps the socket the instant Azure says anything at all", () => {
    // One hypothesis proves both halves: the graph runs and the socket is
    // two-way. Nothing else can override it.
    expect(
      micVerdict({
        frames: 0,
        voicedMs: 99999,
        audibleMs: 0,
        sinceStartMs: 99999,
        heard: true
      })
    ).toBe("streaming");
  });

  it("calls a graph that delivered nothing dead, and only after the fence", () => {
    // The iPhone case. Before MIC_SILENT_MS it is just a mic warming up.
    expect(
      micVerdict({
        frames: 0,
        voicedMs: 0,
        audibleMs: 0,
        sinceStartMs: MIC_SILENT_MS - 1,
        heard: false
      })
    ).toBe("streaming");
    expect(
      micVerdict({
        frames: 0,
        voicedMs: 0,
        audibleMs: 0,
        sinceStartMs: MIC_SILENT_MS,
        heard: false
      })
    ).toBe("dead-graph");
  });

  it("does not call a running graph dead just because nobody has spoken", () => {
    // Audio is flowing, it is simply quiet. Dropping this press into the
    // slower mic would be a bug invented by the fix for the other one. Note
    // what makes this reading different from the dead-capture one below: the
    // chunks carry room tone, not zeroes.
    expect(
      micVerdict({
        frames: 200,
        voicedMs: 0,
        // Room tone. Quiet, and emphatically not zero — that difference is
        // the whole of STREAM_MUTE_MS.
        audibleMs: 60000,
        sinceStartMs: STREAM_NO_RESULT_MS - 1,
        heard: false
      })
    ).toBe("streaming");
  });

  it("waits for VOICED audio, not wall clock, before blaming the socket", () => {
    // Somebody who presses the mic and then thinks for ten seconds has not
    // found a broken socket. Only real speech advances this clock.
    expect(
      micVerdict({
        frames: 500,
        voicedMs: STREAM_DEAF_MS - 1,
        audibleMs: 5000,
        sinceStartMs: STREAM_NO_RESULT_MS - 1,
        heard: false
      })
    ).toBe("streaming");
    expect(
      micVerdict({
        frames: 500,
        voicedMs: STREAM_DEAF_MS,
        audibleMs: 30000,
        sinceStartMs: 30000,
        heard: false
      })
    ).toBe("deaf-socket");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Tom's 8/31 field report, as a reading. This is the one the branch exists
  // for and the one `frames` alone could never see.
  // ─────────────────────────────────────────────────────────────────────────

  it("calls a RUNNING graph dead when every chunk it delivers is zeroes", () => {
    // Button lit, timer counting, Azure connected, `frames` climbing, not one
    // word. The old rule read this as a healthy microphone forever, because
    // the only question it asked was whether chunks were arriving.
    expect(
      micVerdict({
        frames: 400,
        voicedMs: 0,
        audibleMs: 0,
        sinceStartMs: STREAM_MUTE_MS - 1,
        heard: false
      })
    ).toBe("streaming");
    expect(
      micVerdict({
        frames: 400,
        voicedMs: 0,
        audibleMs: 0,
        sinceStartMs: STREAM_MUTE_MS,
        heard: false
      })
    ).toBe("dead-graph");
  });

  it("sends digital silence to BATCH, not to salvage", () => {
    // The distinction that decides whether the fallback works. What was
    // retained during a silent capture is that same silence, so uploading it
    // would transcribe nothing; `recoverToBatch` re-opens the microphone
    // through MediaRecorder instead, which does not touch Web Audio at all.
    expect(
      micVerdict({
        frames: 400,
        voicedMs: 0,
        audibleMs: 0,
        sinceStartMs: 30000,
        heard: false
      })
    ).not.toBe("deaf-socket");
  });

  it("backstops the middle ground: signal, no speech, no answer, forever", () => {
    // A capture path delivering a DC offset or a trickle of dither clears
    // DIGITAL_SILENCE_RMS, so rule 3 lets it past, and never becomes a word,
    // so rule 4 never fires. Twelve seconds of that is not a mic either.
    expect(
      micVerdict({
        frames: 500,
        voicedMs: 0,
        audibleMs: 11000,
        sinceStartMs: STREAM_NO_RESULT_MS - 1,
        heard: false
      })
    ).toBe("streaming");
    expect(
      micVerdict({
        frames: 500,
        voicedMs: 0,
        audibleMs: 12000,
        sinceStartMs: STREAM_NO_RESULT_MS,
        heard: false
      })
    ).toBe("dead-graph");
  });

  it("keeps the recording when the backstop fires on audio that had speech in it", () => {
    // Same twelve seconds, but somebody DID talk into it — under the deaf
    // fence, so rule 4 never tripped. There is a real recording to salvage
    // and losing it would be the worse bug.
    expect(
      micVerdict({
        frames: 500,
        voicedMs: STREAM_DEAF_MS - 1,
        audibleMs: 12000,
        sinceStartMs: STREAM_NO_RESULT_MS,
        heard: false
      })
    ).toBe("deaf-socket");
  });

  it("never leaves a connected, wordless session undiagnosed", () => {
    // The property behind the whole ladder, asserted as a property: past the
    // backstop there is no combination of counters that still reads
    // "streaming" while Azure has said nothing. That is the shape of the bug
    // — lit, counting, silent — and it is now unreachable.
    for (const frames of [0, 1, 400]) {
      for (const voicedMs of [0, 10, STREAM_DEAF_MS]) {
        for (const audibleMs of [0, 500, 12000]) {
          expect(
            micVerdict({ frames, voicedMs, audibleMs, sinceStartMs: 30000, heard: false })
          ).not.toBe("streaming");
        }
      }
    }
  });

  it("prefers the lossless diagnosis when both could apply", () => {
    // frames === 0 cannot coexist with voiced audio in practice, but if the
    // counters ever disagreed, "dead-graph" is the one that restarts cleanly
    // with nothing said yet — the reading that cannot lose words.
    expect(
      micVerdict({
        frames: 0,
        voicedMs: STREAM_DEAF_MS,
        audibleMs: STREAM_DEAF_MS,
        sinceStartMs: MIC_SILENT_MS,
        heard: false
      })
    ).toBe("dead-graph");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. What actually comes out of the pipe
// ───────────────────────────────────────────────────────────────────────────

describe("the PCM Azure is fed", () => {
  beforeEach(() => {
    rig = installFakeAudio({ sampleRate: 48000 });
  });

  it("resamples the phone's rate down to the one the push stream declares", async () => {
    // 48 kHz in, 16 kHz out, 16-bit mono: 4800 samples become 1600, which is
    // 3200 bytes. If this drifts, Azure hears chipmunks and transcribes noise.
    const chunks: ArrayBuffer[] = [];
    const capture = openMicCapture({ onPcm: (c) => chunks.push(c) });
    await capture.started;
    rig.emit(speech(4800));

    expect(chunks[0].byteLength).toBe((4800 / (48000 / SPEECH_SAMPLE_RATE)) * 2);
    capture.close();
  });

  it("counts speech toward voicedMs and silence toward nothing", async () => {
    const capture = openMicCapture({ onPcm: () => undefined });
    await capture.started;

    rig.emit(roomTone(48000)); // a full second of a quiet room
    expect(capture.voicedMs()).toBe(0);

    rig.emit(speech(48000)); // a full second of talking
    expect(Math.round(capture.voicedMs())).toBe(1000);
    capture.close();
  });

  it("still captures when the browser has no AudioWorklet", async () => {
    // The ScriptProcessor path. Deprecated everywhere and removed nowhere, and
    // it is the only node some WebKit builds will give us.
    vi.unstubAllGlobals();
    rig = installFakeAudio({ noWorklet: true });
    const capture = openMicCapture({ onPcm: () => undefined });
    await capture.started;

    rig.emit(speech(4800));
    expect(capture.frames()).toBe(1);
    capture.close();
  });
});

describe("the salvaged WAV — a deaf socket must not cost the sentence", () => {
  beforeEach(() => {
    rig = installFakeAudio({ sampleRate: 48000 });
  });

  async function retained(): Promise<MicCapture> {
    const capture = openMicCapture({ onPcm: () => undefined, retain: true });
    await capture.started;
    rig.emit(speech(48000));
    return capture;
  }

  it("writes a RIFF header the transcriber will accept", async () => {
    // Raw samples with a .wav name come back "unsupported" — the same trap the
    // batch mic's mime ladder exists for. Check the actual bytes.
    const capture = await retained();
    const wav = capture.toWav();
    expect(wav).not.toBeNull();

    const view = new DataView(await wav!.arrayBuffer());
    const tag = (at: number) =>
      String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SPEECH_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    // A second of 48 kHz speech is a second of 16 kHz PCM: 32000 bytes.
    expect(view.getUint32(40, true)).toBe(SPEECH_SAMPLE_RATE * 2);
    expect(wav!.size).toBe(44 + SPEECH_SAMPLE_RATE * 2);
    capture.close();
  });

  it("declares audio/wav, which is what FastShell names the upload from", async () => {
    const capture = await retained();
    expect(capture.toWav()?.type).toBe("audio/wav");
    capture.close();
  });

  it("lets the copy go once the socket has proven itself", async () => {
    // Retention exists only for the window in which a deaf socket is still
    // possible. Holding thirty seconds of PCM after the first partial would be
    // memory kept against a problem that has already been ruled out.
    const capture = await retained();
    capture.stopRetaining();
    expect(capture.toWav()).toBeNull();
    capture.close();
  });

  it("retains nothing when it was not asked to", async () => {
    const capture = openMicCapture({ onPcm: () => undefined });
    await capture.started;
    rig.emit(speech(4800));
    expect(capture.toWav()).toBeNull();
    capture.close();
  });
});

describe("handing the microphone on, rather than asking twice", () => {
  beforeEach(() => {
    rig = installFakeAudio();
  });

  it("returns the live stream and leaves its tracks running", async () => {
    // The fallback's whole trick. MediaRecorder needs a MediaStream and does
    // not touch Web Audio, so a press whose audio graph died can carry its
    // already-granted microphone across to the batch mic.
    const capture = openMicCapture({ onPcm: () => undefined });
    await capture.started;

    const stream = capture.detachStream();
    expect(stream).not.toBeNull();
    expect(rig.tracksStopped()).toBe(0);
    expect(rig.contextClosed()).toBe(true); // the graph goes; the mic stays
  });

  it("stops delivering audio once the graph is gone", async () => {
    const capture = openMicCapture({ onPcm: () => undefined });
    await capture.started;
    capture.detachStream();

    rig.emit(speech(4800));
    expect(capture.frames()).toBe(0);
  });

  it("does not stop a microphone it no longer owns", async () => {
    // close() normally stops every track — it must not, once somebody else is
    // recording with them, or the batch mic dies the instant it starts.
    const capture = openMicCapture({ onPcm: () => undefined });
    await capture.started;
    capture.detachStream();
    capture.close();

    expect(rig.tracksStopped()).toBe(0);
  });

  it("has nothing to hand over when the mic never arrived", async () => {
    vi.unstubAllGlobals();
    rig = installFakeAudio({ denyMic: true });
    const capture = openMicCapture({ onPcm: () => undefined });
    await capture.started.catch(() => undefined);
    expect(capture.detachStream()).toBeNull();
  });
});

describe("letting go of the microphone", () => {
  beforeEach(() => {
    rig = installFakeAudio();
  });

  it("stops every track, because the browser shows a recorder until it does", async () => {
    const capture = openMicCapture({ onPcm: () => undefined });
    await capture.started;
    capture.close();
    expect(rig.tracksStopped()).toBe(1);
    expect(rig.contextClosed()).toBe(true);
  });

  it("survives being closed twice", async () => {
    const capture = openMicCapture({ onPcm: () => undefined });
    await capture.started;
    capture.close();
    capture.close();
    expect(rig.tracksStopped()).toBe(1);
  });

  it("delivers nothing after close, so a late frame cannot resurrect a session", async () => {
    const capture = openMicCapture({ onPcm: () => undefined });
    await capture.started;
    capture.close();
    rig.emit(speech(4800));
    expect(capture.frames()).toBe(0);
  });

  it("releases a microphone that arrived after the press was abandoned", async () => {
    // Close during the async gap: getUserMedia is already in flight and its
    // stream lands on a session nobody is waiting for. Leaving it running is a
    // recording indicator that never goes away.
    const capture = openMicCapture({ onPcm: () => undefined });
    capture.close();
    await capture.started.catch(() => undefined);
    expect(rig.tracksStopped()).toBe(1);
  });
});
