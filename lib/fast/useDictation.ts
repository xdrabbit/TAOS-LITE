"use client";

// The mic on /fast. Hold it or tap it; the words land in the input box.
//
// This is the same recorder the rest of the app already runs — ChatShell's
// voice note and TranslatorShell's spoken turn — with the same three hard-won
// pieces kept intact, because each of them was a bug once:
//
//   • the mime ladder (webm/opus on Chrome and Android, mp4 on iOS Safari);
//   • the 32 kbps bitrate cap, so an upload stays small;
//   • interrupted-mic recovery — iOS Safari ends the mic track SILENTLY when
//     the audio session is taken (incoming call, Siri, another app), and
//     without `onerror` + `track.onended` the recording dies with the button
//     still lit and the audio lost. Liz, 7/27: "a veces simplemente deja de
//     transmitirse… y se apaga". Both handlers route through the normal stop,
//     so whatever was heard before the interruption is still transcribed.
//
// What is NOT here is a second idea about audio. It records, it stops, it
// hands back a blob. Where that blob goes, and what it costs, is the caller's
// business — which on /fast is one POST to /api/fast/listen and then the same
// as-you-type flow a keyboard would have started.
//
// ── Hold or tap ────────────────────────────────────────────────────────────
// Both, because both are things people do to a mic button and guessing wrong
// is a lost sentence either way. A press that is released quickly LATCHES —
// it keeps recording until the next tap. A press held past that threshold is
// push-to-talk and ends when the finger lifts.
import { useCallback, useEffect, useRef, useState } from "react";
import { FAST_MAX_DICTATION_MS, FAST_MIN_DICTATION_MS } from "@/lib/fast/dictation";

/** Chrome/Android record webm/opus; iOS Safari records mp4/aac. */
function pickRecordingMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"]) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* some browsers throw on an unknown codec string rather than saying no */
    }
  }
  return "";
}

/**
 * Voice-friendly bitrate, same as TranslatorShell's: 32 kbps is ~120 KB for a
 * full thirty seconds, which keeps the upload small on a bad connection and
 * keeps the buffer from growing unbounded if a recording is forgotten about.
 */
const AUDIO_BITS_PER_SECOND = 32000;

/**
 * A press shorter than this is a TAP and latches the recording on. Longer and
 * it is a hold, ending when the finger lifts. 400ms is comfortably past a
 * deliberate tap and comfortably short of anybody's idea of "holding" it.
 *
 * Exported because the LIVE mic (lib/fast/useLiveDictation.ts) has to make the
 * same hold-or-tap call about the same button. A second copy of this number
 * would be a button whose meaning changed depending on which recogniser
 * happened to be available.
 */
export const TAP_MS = 400;

export type DictationState = "idle" | "recording" | "working";

export interface Dictation {
  state: DictationState;
  /** True while the recording is latched on by a tap rather than a held finger. */
  latched: boolean;
  /** Whole seconds recorded so far, for the countdown against the 30s cap. */
  seconds: number;
  /** Press handler for the mic button — begins, or ends a latched recording. */
  press: () => void;
  /** Release handler — ends a held recording, or latches a tapped one. */
  release: () => void;
  /** Abandon whatever is being recorded without transcribing it. */
  cancel: () => void;
}

export interface DictationOptions {
  /**
   * Called with the finished audio. Async, and `state` stays "working" until
   * it settles — the button must not invite a second recording while the
   * first one is still being transcribed.
   */
  onAudio: (blob: Blob, mimeType: string) => Promise<void>;
  /** Something went wrong before any audio existed, in words for a person. */
  onError: (message: string) => void;
  /** Fires when the caller should clear whatever error is on screen. */
  onStart?: () => void;
  /**
   * A microphone that is already open, if there is one.
   *
   * The live mic (lib/fast/useLiveDictation.ts) opens the microphone itself,
   * inside the user gesture, and when the SOCKET gives up it hands that same
   * stream down here rather than letting this hook ask the phone for a second
   * one. Two getUserMedia calls a second apart is how iOS gives you a stream
   * that records silence. Returns null when there is nothing to inherit,
   * which is the ordinary case and the one that asks for the mic normally.
   *
   * It returns null in one more case, deliberately: when streaming gave up
   * because the audio it was capturing was DIGITAL SILENCE. That verdict
   * accuses the microphone, so that press arrives here with its old tracks
   * already stopped and this hook opens a fresh one — inheriting a track that
   * is provably delivering zeroes is inheriting the bug. The whole argument
   * is written out at `discardCapture` in the live hook.
   *
   * Consumed once: whatever it returns, this hook owns and stops.
   */
  adopt?: () => MediaStream | null;
}

export function useDictation({
  onAudio,
  onError,
  onStart,
  adopt
}: DictationOptions): Dictation {
  const [state, setState] = useState<DictationState>("idle");
  const [latched, setLatched] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("");
  const startedAtRef = useRef(0);
  const pressedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  // The finger lifted before getUserMedia resolved. The FIRST ever dictation
  // puts a permission prompt in the middle of the press, so the press looks
  // "held" for as long as the prompt was on screen — which would end the
  // recording the instant it began. A release that lands before there is
  // anything to release always latches instead: the forgiving reading, and
  // one more tap undoes it.
  const pendingLatchRef = useRef(false);
  const tickRef = useRef<number | null>(null);
  const capRef = useRef<number | null>(null);

  // The handlers below are attached to a MediaRecorder that outlives the
  // render it was created in, so they read the callers through refs rather
  // than closing over a particular render's copy.
  const onAudioRef = useRef(onAudio);
  const onErrorRef = useRef(onError);
  const adoptRef = useRef(adopt);
  useEffect(() => {
    onAudioRef.current = onAudio;
    onErrorRef.current = onError;
    adoptRef.current = adopt;
  }, [adopt, onAudio, onError]);

  const clearTimers = useCallback(() => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    if (capRef.current !== null) window.clearTimeout(capRef.current);
    tickRef.current = null;
    capRef.current = null;
  }, []);

  /** Let go of the microphone. The browser shows a recording indicator until
   *  every track is stopped, so this is not optional politeness. */
  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const stop = useCallback(() => {
    clearTimers();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop(); // onstop does the rest
    } else {
      releaseMic();
      setState("idle");
      setLatched(false);
    }
  }, [clearTimers, releaseMic]);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    onStart?.();
    // An inherited microphone is still a microphone: a browser with no
    // getUserMedia at all cannot have handed us one, but a browser whose Web
    // Audio failed can — and that press must not be turned away here.
    const inherited = adoptRef.current?.() ?? null;
    if (
      !inherited &&
      (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia)
    ) {
      onErrorRef.current("This browser can't record audio. Type it instead.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      inherited?.getTracks().forEach((t) => t.stop());
      onErrorRef.current("This browser can't record audio. Type it instead.");
      return;
    }
    try {
      const stream = inherited ?? (await navigator.mediaDevices.getUserMedia({ audio: true }));
      streamRef.current = stream;
      const mime = pickRecordingMime();
      mimeRef.current = mime;
      const opts: MediaRecorderOptions = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
      if (mime) opts.mimeType = mime;
      const recorder = new MediaRecorder(stream, opts);
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      // Interrupted mic, both shapes. See the header note — finishing the turn
      // early with what was captured beats dying silently with the button lit.
      recorder.onerror = () => {
        if (recorder.state !== "inactive") recorder.stop();
      };
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          if (recorder.state !== "inactive") recorder.stop();
        };
      }
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        const type = recorder.mimeType || mimeRef.current || "audio/webm";
        const heldMs = performance.now() - startedAtRef.current;
        const cancelled = cancelledRef.current;
        clearTimers();
        releaseMic();
        recorderRef.current = null;
        chunksRef.current = [];
        setLatched(false);
        setSeconds(0);
        if (cancelled) {
          setState("idle");
          return;
        }
        // A fumbled tap. Sub-second clips carry no usable speech and the
        // shortest ones lack complete container headers, so the provider
        // rejects them as corrupted — catch it here rather than paying to
        // find out (same rule and same 600ms as TranslatorShell).
        if (heldMs < FAST_MIN_DICTATION_MS || !chunks.length) {
          setState("idle");
          onErrorRef.current("Too short — hold the mic and say it again.");
          return;
        }
        setState("working");
        void onAudioRef.current(new Blob(chunks, { type }), type).finally(() =>
          setState("idle")
        );
      };

      // Flush into chunks every second so an interrupted recording is never
      // one fragile buffer that a suspended page can lose whole.
      recorder.start(1000);
      startedAtRef.current = performance.now();
      setState("recording");
      setSeconds(0);
      if (pendingLatchRef.current) {
        pendingLatchRef.current = false;
        setLatched(true);
      }
      tickRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
      // The hard stop. A setTimeout and not the tick, because a throttled
      // background tab can stretch an interval but this is a spend bound.
      capRef.current = window.setTimeout(stop, FAST_MAX_DICTATION_MS);
    } catch (e) {
      releaseMic();
      recorderRef.current = null;
      clearTimers();
      setState("idle");
      onErrorRef.current(
        e instanceof Error && e.name === "NotAllowedError"
          ? "Microphone access was denied. · Micrófono denegado."
          : "Could not start recording."
      );
    }
  }, [clearTimers, onStart, releaseMic, stop]);

  const press = useCallback(() => {
    // A press while a latched recording is running is the tap that ends it.
    if (state === "recording") {
      stop();
      return;
    }
    if (state === "working") return; // one dictation at a time
    pressedAtRef.current = performance.now();
    pendingLatchRef.current = false;
    void start();
  }, [start, state, stop]);

  const release = useCallback(() => {
    // Nothing is recording yet — the stream (or the permission prompt) is
    // still resolving. Latch when it arrives; see pendingLatchRef.
    if (state !== "recording") {
      if (recorderRef.current === null && state === "idle") pendingLatchRef.current = true;
      return;
    }
    if (performance.now() - pressedAtRef.current < TAP_MS) {
      setLatched(true); // it was a tap — keep listening until the next one
      return;
    }
    stop();
  }, [state, stop]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stop();
  }, [stop]);

  // Leaving the screen mid-recording must not leave the mic open.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      if (capRef.current !== null) window.clearTimeout(capRef.current);
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  return { state, latched, seconds, press, release, cancel };
}
