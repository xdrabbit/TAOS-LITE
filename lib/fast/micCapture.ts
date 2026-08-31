"use client";

// The microphone, opened the way an iPhone insists on.
//
// ── The bug this module is ─────────────────────────────────────────────────
// Tom's field report: the /fast mic "has trouble" on iPhone. Desktop fine.
// The symptom is the worst shape a mic can fail in — the button lights up,
// the timer counts, the socket to Azure is genuinely open, and not one word
// ever appears. A dead mic that looks like a working one.
//
// The cause is WebKit's rule about Web Audio, and the Speech SDK walking
// straight into it. `MicAudioSource.turnOn()` does this, in this order:
//
//   1. new AudioContext({ sampleRate: 16000 })
//   2. if (context.state === "suspended") context.resume()
//   3. getUserMedia
//
// On iOS an AudioContext is born SUSPENDED unless it is constructed inside a
// user gesture, and `resume()` only actually starts one when IT is called
// inside a user gesture too. The SDK does both — but it does them from inside
// `startContinuousRecognitionAsync`, which the old hook reached only after
// `await ensureWarm()`. By then the tap's task is long over. WebKit does not
// throw for this; it resolves the promise and leaves the context stopped. So
// the recogniser starts successfully, the AudioWorklet never runs, zero PCM is
// ever sent, and Azure — hearing digital silence on a continuous session —
// never emits a partial, a final, OR a cancellation. Nothing rejects, so
// nothing falls back.
//
// Chrome and Firefox have no such rule, which is exactly why every desktop
// walkthrough passed.
//
// ── So this module owns the capture ────────────────────────────────────────
// There is no way to hand the SDK an AudioContext — `createAudioContext()` is
// private and takes no argument — and `AudioConfig.fromStreamInput(stream)`
// only skips step 3, not the two that matter. The only way to construct the
// context in the gesture is to construct it ourselves and push PCM into the
// SDK through a push stream.
//
// Everything gesture-critical therefore happens SYNCHRONOUSLY in
// `openMicCapture`, which the mic button calls before it awaits anything:
//
//   • the AudioContext is constructed;
//   • resume() is called on it;
//   • getUserMedia is called.
//
// Not one `await` sits in front of any of them. That is the whole fix, and it
// is why this function returns a handle with a promise on it rather than being
// an async function — an async function could not have been called in time.
//
// ── The sample rate is deliberately NOT forced ─────────────────────────────
// The SDK asks for a 16 kHz context. iOS runs its capture session at the
// hardware rate (usually 48 kHz), and asking WebKit for a graph at a rate the
// session is not running at is its own separate silence bug. So we take
// whatever rate the phone gives us and resample on the way out — the same box
// average the SDK's own RiffPcmEncoder does, so what Azure hears is unchanged.
//
// ── And it counts what it delivered ────────────────────────────────────────
// The fallback needed a signal, and "the socket opened" was never one. A
// suspended context delivers ZERO chunks — that is the iOS signature, it is
// observable in under two seconds, and `frames()` is how the hook sees it. A
// context that runs but talks to a socket that is not listening delivers
// chunks with real energy in them and gets no partials back, which is what
// `voicedMs()` is for. Between them the mic can tell a dead audio graph from a
// dead socket from somebody who simply has not started talking yet.

import {
  MIC_SILENT_MS,
  STREAM_DEAF_MS,
  STREAM_MUTE_MS,
  STREAM_NO_RESULT_MS
} from "@/lib/fast/dictation";

/** What Azure's push stream is fed, and what everything here resamples to. */
export const SPEECH_SAMPLE_RATE = 16000;

/**
 * RMS above which a chunk counts as somebody talking rather than room tone.
 *
 * It exists to keep the dead-socket watchdog honest: a person who presses the
 * mic and then thinks for three seconds must not be read as a broken socket.
 * Only audio with speech-like energy in it starts that clock.
 */
const VOICED_RMS = 0.01;

/**
 * RMS below which a chunk carries no signal AT ALL — not room tone, nothing.
 *
 * Two orders of magnitude under VOICED_RMS, and the gap between them is the
 * point. VOICED_RMS asks "is somebody talking?"; this asks the much narrower
 * question "is this capture path alive?", which is the one Tom's 8/31 field
 * report turns on. A microphone that is merely in a silent room still clears
 * this by a wide margin — self-noise alone is around 1e-3 — so a run of
 * chunks under it means the samples are zeroes and the mic is not really
 * open. See STREAM_MUTE_MS.
 */
const DIGITAL_SILENCE_RMS = 1e-4;

export interface MicCaptureOptions {
  /** One chunk of mono 16-bit little-endian PCM at SPEECH_SAMPLE_RATE. */
  onPcm: (chunk: ArrayBuffer) => void;
  /**
   * Keep a copy of every chunk, so a session that turns out to be talking to
   * a dead socket can still be salvaged as one batch upload instead of asking
   * somebody to say it again. Dropped by `stopRetaining()` the moment the
   * first partial proves the socket is alive.
   */
  retain?: boolean;
}

export interface MicCapture {
  /**
   * Resolves once the graph is wired and the mic is live; rejects if the mic
   * was refused or Web Audio is unavailable. Resolving does NOT promise audio
   * is flowing — on the platform this module exists for, that is precisely the
   * thing that can still be false. `frames()` is what promises it.
   */
  started: Promise<void>;
  /** PCM chunks delivered so far. Still 0 a second in means a stopped graph. */
  frames: () => number;
  /** Milliseconds of delivered audio that had speech-like energy in it. */
  voicedMs: () => number;
  /**
   * Milliseconds of delivered audio carrying ANY signal — the much lower bar
   * of "these samples are not all zero". `frames()` says the graph is running;
   * this says the graph is running and the microphone is attached to it.
   */
  audibleMs: () => number;
  /** Everything retained, as a WAV file, or null if nothing was retained. */
  toWav: () => Blob | null;
  /** Let the retained copy go — the socket is proven, nothing to salvage. */
  stopRetaining: () => void;
  /**
   * Give up the audio graph but KEEP the microphone, and hand the live
   * MediaStream to whoever asked.
   *
   * This is what the SOCKET fallback uses. The batch mic needs a MediaStream
   * and nothing else — MediaRecorder does not touch Web Audio — so a press
   * that gives up on streaming because the token, the SDK or the websocket
   * failed can carry its already-granted, already-open microphone across
   * instead of stopping every track and asking the phone for it a second
   * time. On iOS especially, a close/reopen cycle in the same second is a
   * good way to get a stream that records silence.
   *
   * It is emphatically NOT for the fallback that fires because the audio is
   * silent. That verdict accuses this stream, and inheriting it would put the
   * same dead track behind MediaRecorder — see `discardCapture` in
   * lib/fast/useLiveDictation.ts, which calls `close()` instead.
   *
   * The caller owns the stream afterwards: `close()` will no longer stop it.
   */
  detachStream: () => MediaStream | null;
  /** Close the graph and release the microphone. Safe to call twice. */
  close: () => void;
}

/** The worklet, inline: a module URL is the only way to load one. */
const WORKLET_SOURCE = `class FastMicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor('fast-mic-processor', FastMicProcessor);`;

/** The SDK's own box average (RiffPcmEncoder), so Azure hears what it did. */
function downsample(frame: Float32Array, srcRate: number): Float32Array {
  if (srcRate <= SPEECH_SAMPLE_RATE) return frame;
  const ratio = srcRate / SPEECH_SAMPLE_RATE;
  const out = new Float32Array(Math.round(frame.length / ratio));
  let src = 0;
  for (let dst = 0; dst < out.length; dst++) {
    const until = Math.round((dst + 1) * ratio);
    let sum = 0;
    let n = 0;
    while (src < until && src < frame.length) {
      sum += frame[src++];
      n++;
    }
    out[dst] = n ? sum / n : 0;
  }
  return out;
}

function toPcm16(frame: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(frame.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < frame.length; i++) {
    const s = Math.max(-1, Math.min(1, frame[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function rms(frame: Float32Array): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/**
 * A RIFF header around raw PCM, so the salvage path can post a real file.
 *
 * /api/fast/listen hands the upload to the transcriber, which sniffs the
 * container — raw samples with a .wav name come back "unsupported", which is
 * the same trap the batch mic's mime ladder was written for.
 */
function wavFrom(chunks: readonly ArrayBuffer[]): Blob {
  const bytes = chunks.reduce((n, c) => n + c.byteLength, 0);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SPEECH_SAMPLE_RATE, true);
  view.setUint32(28, SPEECH_SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, bytes, true);
  return new Blob([header, ...chunks], { type: "audio/wav" });
}

/**
 * Open the microphone. MUST be called synchronously from the press handler —
 * see the header. Everything iOS measures against the user gesture happens
 * before this function returns.
 */
export function openMicCapture(options: MicCaptureOptions): MicCapture {
  const { onPcm, retain = false } = options;

  const Ctor: typeof AudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio unavailable");
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia unavailable");
  }

  // ── The three lines the iPhone is watching ──────────────────────────────
  // No sample rate: see the header. No await in front of any of them.
  const context = new Ctor();
  const resumed = Promise.resolve(context.resume?.()).catch(() => undefined);
  const micStream = navigator.mediaDevices.getUserMedia({ audio: true });

  let closed = false;
  // False once detachStream has handed the microphone to somebody else, so
  // close() stops tearing down tracks it no longer owns.
  let ownsStream = true;
  let frames = 0;
  let voicedMs = 0;
  let audibleMs = 0;
  let retained: ArrayBuffer[] | null = retain ? [] : null;
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let sink: AudioNode | null = null;
  let mute: GainNode | null = null;
  let workletUrl: string | null = null;

  const deliver = (raw: Float32Array): void => {
    if (closed) return;
    const frame = downsample(raw, context.sampleRate);
    if (!frame.length) return;
    frames++;
    const level = rms(frame);
    const ms = (frame.length / SPEECH_SAMPLE_RATE) * 1000;
    if (level >= VOICED_RMS) voicedMs += ms;
    if (level >= DIGITAL_SILENCE_RMS) audibleMs += ms;
    const pcm = toPcm16(frame);
    if (retained) retained.push(pcm.slice(0));
    onPcm(pcm);
  };

  /** Tear the audio graph down. Idempotent, and leaves the tracks alone. */
  const dropGraph = (): void => {
    if (closed) return;
    closed = true;
    if (sink) {
      try {
        sink.disconnect();
      } catch {
        /* already gone */
      }
      if ("port" in sink) (sink as AudioWorkletNode).port.onmessage = null;
      else (sink as ScriptProcessorNode).onaudioprocess = null;
    }
    source?.disconnect();
    mute?.disconnect();
    if (workletUrl) URL.revokeObjectURL(workletUrl);
    void context.close().catch(() => undefined);
  };

  const started = (async (): Promise<void> => {
    stream = await micStream;
    if (closed) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("closed");
    }
    // Awaited here rather than in the gesture: the CALL is what iOS cares
    // about, and it was made above. A rejection is not fatal on its own —
    // frames() is the honest test of whether the graph runs.
    await resumed;
    if (closed) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("closed");
    }

    source = context.createMediaStreamSource(stream);
    // Gain 0 into the speakers. The graph has to be pulled by a destination
    // to run at all, and a phone whose mic is wired to its own loudspeaker is
    // a feedback howl waiting for the first field test.
    mute = context.createGain();
    mute.gain.value = 0;
    mute.connect(context.destination);

    // Worklet first and ScriptProcessor second, the same order and the same
    // reason as the SDK: the worklet keeps the capture off the UI thread, and
    // the deprecated node is still the only one that exists everywhere.
    if (context.audioWorklet) {
      try {
        workletUrl = URL.createObjectURL(
          new Blob([WORKLET_SOURCE], { type: "application/javascript" })
        );
        await context.audioWorklet.addModule(workletUrl);
        if (closed) throw new Error("closed");
        const node = new AudioWorkletNode(context, "fast-mic-processor");
        node.port.onmessage = (ev: MessageEvent<Float32Array>) => deliver(ev.data);
        source.connect(node);
        node.connect(mute);
        sink = node;
        return;
      } catch {
        /* fall through to the ScriptProcessor below */
      }
    }
    if (closed) throw new Error("closed");
    const node = context.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (ev) => deliver(new Float32Array(ev.inputBuffer.getChannelData(0)));
    source.connect(node);
    node.connect(mute);
    sink = node;
  })();
  // Nobody is awaiting `started` yet and a refused mic must not surface as an
  // unhandled rejection. The hook reads it properly a tick later.
  started.catch(() => undefined);

  return {
    started,
    frames: () => frames,
    voicedMs: () => voicedMs,
    audibleMs: () => audibleMs,
    toWav: () => (retained && retained.length ? wavFrom(retained) : null),
    stopRetaining: () => {
      retained = null;
    },
    detachStream: () => {
      const live = stream;
      if (!live) return null;
      ownsStream = false;
      dropGraph();
      stream = null;
      return live;
    },
    close: () => {
      if (closed) return;
      dropGraph();
      // The browser shows a recording indicator until every track is stopped,
      // so this is not optional politeness (the batch mic's note, same rule).
      // Unless the stream was handed on, in which case stopping it here would
      // kill the microphone out from under the mic that inherited it.
      if (ownsStream) stream?.getTracks().forEach((t) => t.stop());
      retained = null;
    }
  };
}

/**
 * What a streaming session looks like from outside, and what to do about it.
 *
 * "streaming" is the answer to keep the socket. The other two are the failures
 * that do NOT throw, which is the whole reason this function exists: the old
 * mic fell back only when `beginStream` rejected, and an iPhone's dead audio
 * graph rejects nothing at all.
 */
export type MicVerdict = "streaming" | "dead-graph" | "deaf-socket";

export interface MicReading {
  /** Chunks the audio graph has delivered. */
  frames: number;
  /** Milliseconds of delivered audio with speech-like energy in it. */
  voicedMs: number;
  /** Milliseconds of delivered audio carrying any signal above digital zero. */
  audibleMs: number;
  /** Wall clock since the recogniser reported itself started. */
  sinceStartMs: number;
  /** Has Azure sent back a hypothesis, a final, or anything at all? */
  heard: boolean;
}

/**
 * Read a live session and say whether it is still a microphone.
 *
 * Pure and separate from the hook on purpose: this is the rule the iPhone bug
 * was missing, and a rule that only exists inside a React effect is a rule no
 * test can put a number to.
 *
 * Four rules, in order, and they are ordered by how much they can prove. Each
 * one below the first is a different way of noticing the SAME failure — a
 * session that is connected and producing no words — because that failure has
 * more than one cause and only one appearance. The whole point of the ladder
 * is that no arrangement of "connected, lit, counting, silent" is allowed to
 * last indefinitely: something always fires.
 */
export function micVerdict(reading: MicReading): MicVerdict {
  // 1. Azure answered. Whatever else is true, this socket is two-way and this
  // graph is running — every other signal here is a proxy for that one.
  if (reading.heard) return "streaming";

  // 2. Nothing has been captured AT ALL well after the recogniser started. A
  // running graph delivers its first chunk in tens of milliseconds, so this is
  // a context that never actually started: WebKit's answer to an AudioContext
  // built outside the tap. Nothing has been heard, so nothing can be lost.
  if (reading.frames === 0 && reading.sinceStartMs >= MIC_SILENT_MS) return "dead-graph";

  // 3. Chunks ARE arriving and every one of them is zeroes. This is the case
  // rule 2 misses and Tom hit: the graph runs, `frames` climbs, the timer
  // counts, and the microphone on the other end of it is not delivering audio.
  // A real mic in a silent room clears DIGITAL_SILENCE_RMS on its self-noise,
  // so four seconds of literal zero is a capture path and not a quiet person.
  // Batch, not salvage: what was retained is that same silence, and the
  // fallback re-opens the microphone through MediaRecorder — a NEW
  // getUserMedia, not this one's track, because the layer this rule cannot
  // see between might be the track itself. Web Audio is not involved either
  // way.
  if (reading.audibleMs === 0 && reading.sinceStartMs >= STREAM_MUTE_MS) return "dead-graph";

  // 4. Audio is flowing and somebody is talking into it, and Azure has said
  // nothing back for four seconds of it. The graph is fine; the socket is not,
  // and the retained copy is worth uploading.
  if (reading.voicedMs >= STREAM_DEAF_MS) return "deaf-socket";

  // 5. The backstop, for the middle ground the three above leave: a trickle of
  // signal that is neither zero nor speech, unanswered for long enough that no
  // explanation is left. Where it goes depends on whether there is anything
  // worth salvaging — if real speech went in, the retained copy is a
  // transcription somebody is owed; if it did not, re-open the mic instead.
  if (reading.sinceStartMs >= STREAM_NO_RESULT_MS) {
    return reading.voicedMs > 0 ? "deaf-socket" : "dead-graph";
  }

  return "streaming";
}
