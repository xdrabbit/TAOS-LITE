"use client";

// The live mic on /fast — words that land WHILE you are still saying them.
//
// ── What was wrong with the batch mic ──────────────────────────────────────
// The first mic (lib/fast/useDictation.ts) records to a buffer, uploads on
// release, and writes the whole transcript into the box in one lump. It works,
// and on the screen whose soul is instant it feels dead: you talk to a button
// that does nothing, for as long as you talk, and then everything happens at
// once. Tom's field report was exactly that — right feature, wrong screen for
// a progress bar.
//
// So this hook opens a websocket from the phone to Azure Speech and renders
// the hypotheses as they arrive. Audio does NOT go through Vercel on the way:
// a function hop per 100ms of speech would spend the latency this exists to
// save. The credential for that socket is minted server-side and lives ten
// minutes (POST /api/fast/speech-token) — AZURE_SPEECH_KEY never reaches a
// browser.
//
// ── Why this hook owns the microphone ──────────────────────────────────────
// It used to hand the SDK `AudioConfig.fromDefaultMicrophoneInput()` and let
// it open the mic itself. On an iPhone that is a dead mic, and the second
// field report was exactly that. The SDK builds its AudioContext and calls
// resume() from inside `startContinuousRecognitionAsync` — which this hook
// only reached after `await ensureWarm()`, so both landed outside the tap's
// user gesture, which is the one thing WebKit will not allow. It does not
// throw for it: the context stays stopped, the recogniser starts anyway, the
// socket opens, the button lights up, and not one PCM sample is ever sent.
// Azure hears digital silence and, on a continuous session, answers with
// nothing at all — no partial, no final, and no cancellation to reject on.
// Nothing failed, so nothing fell back, and the mic was dead for the rest of
// the visit. Chrome and Firefox have no gesture rule, which is why every
// desktop walkthrough passed.
//
// lib/fast/micCapture.ts is the answer: the context and getUserMedia are
// opened SYNCHRONOUSLY in `press`, before this hook awaits anything, and the
// PCM is pushed into the SDK through a push stream. The SDK never touches the
// microphone.
//
// ── Two recognisers, one button ────────────────────────────────────────────
// This hook OWNS the batch mic rather than replacing it, and decides per
// PRESS — not once per page:
//
//   stream   Azure can hear what is about to be said (both pills in Auto, or
//            just the pinned one), the SDK loaded, the token minted, the
//            socket opened, and audio is provably flowing. Partials render
//            live, finals become editable text.
//   batch    anything above was false. The old path, unchanged, silently.
//
// Per press and not once per page, because the reasons streaming fails are
// mostly WEATHER — a token that expired, a tunnel, a dropped socket. A phone
// that fell back once on a bad platform and then refused to stream for the
// rest of the trip would be a worse bug than the one this fixes, and an
// invisible one.
//
// "Silently" is the requirement. A mic that explains why it is in its slower
// mode is a mic that interrupts somebody mid-errand to discuss infrastructure.
// The fallback is real and permanent for some pairs by design — Azure Speech
// hears 76 of the catalog's 100 languages and Whisper hears all 100, so a pair
// with Latin or Hawaiian in it is a batch pair forever, not a broken one.
//
// ── Four ways streaming gives up, not one ──────────────────────────────────
// The original fallback fired on one signal: `beginStream` threw. The iPhone
// bug proved that is the one failure mode that platform does NOT produce, so
// there are four now, and three of them are watchdogs rather than exceptions:
//
//   1. it threw          — no SDK, no token, mic refused, socket rejected.
//   2. it never opened   — STREAM_CONNECT_MS with the handshake still hanging.
//   3. it never heard    — MIC_SILENT_MS with zero PCM chunks delivered. This
//                          is the iPhone signature, and nothing has been said
//                          yet, so the whole press goes to the batch mic and
//                          not a word is lost.
//   4. it went unanswered — STREAM_DEAF_MS of VOICED audio with no hypothesis
//                          back. Somebody is mid-sentence here, so this one
//                          salvages instead of restarting: the capture stays
//                          open, the PCM this hook has been retaining keeps
//                          accumulating, and on release it is posted as one
//                          WAV through the batch mic's own upload path. The
//                          mic goes lumpy; the sentence survives.
//
// ── What this hook does NOT do ─────────────────────────────────────────────
// It does not translate, bill, or touch the input box. It reports finalized
// segments to the caller and exposes the tentative tail, and FastShell decides
// what that means — same division as the batch mic, and the reason a spoken
// quickie still costs exactly one settled row (lib/fast/settle.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders, jsonAuthHeaders } from "@/lib/authClient";
import {
  AZURE_TOKEN_REFRESH_MS,
  FAST_MAX_DICTATION_MS,
  STREAM_CONNECT_MS
} from "@/lib/fast/dictation";
import { stepTranscript, type TranscriptEvent } from "@/lib/fast/liveTranscript";
import {
  micVerdict,
  openMicCapture,
  SPEECH_SAMPLE_RATE,
  type MicCapture
} from "@/lib/fast/micCapture";
import { SPEECH_LANGUAGE_ID_MODE } from "@/lib/fast/speechLocale";
import { TAP_MS, useDictation, type DictationState } from "@/lib/fast/useDictation";

/** Which recogniser served the current (or most recent) dictation. */
export type DictationMode = "stream" | "batch";

/**
 * What the CURRENT press is being served by. "salvage" is a streaming session
 * whose socket went deaf: it is still this hook's own capture, but it behaves
 * — and is labelled — as the batch mic, because that is what it now is.
 */
type ActiveMode = "stream" | "batch" | "salvage";

/**
 * How often a live session is held up against micVerdict.
 *
 * Fine enough that the dead-graph case (MIC_SILENT_MS) is caught within a
 * quarter second of its deadline, which is what keeps the iPhone fallback
 * feeling like a mic that thought about it rather than one that broke.
 */
const WATCHDOG_POLL_MS = 250;

export interface LiveDictation {
  state: DictationState;
  /** Which recogniser is in use. null before the first press has decided. */
  mode: DictationMode | null;
  latched: boolean;
  seconds: number;
  /** The tentative tail — words heard but not yet final. "" when none. */
  partial: string;
  press: () => void;
  release: () => void;
  /**
   * Stop now.
   *
   * It means different things in the two modes, and the caller must LABEL it
   * differently because of that (FastShell does):
   *
   *   batch   discards the recording. Nothing was ever transcribed, so
   *           nothing is lost — this is a true cancel.
   *   stream  keeps the words. Finalized segments went into the box as they
   *           were spoken and may already be translated; there is nothing
   *           left to take back, so this only drops the tentative tail.
   *           Calling it "Cancel" there would promise an undo that does not
   *           exist on this screen.
   */
  cancel: () => void;
}

export interface LiveDictationOptions {
  /**
   * Azure locales to identify between (lib/fast/speechLocale.ts), or null when
   * this pair cannot be streamed and the batch mic should take the job.
   */
  candidates: readonly string[] | null;
  /** A finalized run of words, for the caller to append to the input. */
  onSegment: (text: string) => void;
  /** The batch path's finished audio — the caller uploads it. */
  onAudio: (blob: Blob, mimeType: string) => Promise<void>;
  /** Something went wrong in words for a person. */
  onError: (message: string) => void;
  /** Fires when the caller should clear whatever error is on screen. */
  onStart?: () => void;
}

interface HeldToken {
  token: string;
  region: string;
  /** Wall-clock ms after which this token is no good. */
  expiresAt: number;
  /**
   * The ledger row this token reserved (lib/fast/speechMeter.ts).
   *
   * Held here rather than beside the session, because the thing that has to be
   * settled is the RESERVATION, and the reservation belongs to the token: a
   * press that never manages to open a socket still has to give it back.
   */
  sessionId: string | null;
}

type SpeechSdk = typeof import("microsoft-cognitiveservices-speech-sdk");

/** The live session's handle, narrowed to what this hook needs of it. */
interface LiveSession {
  close: () => void;
  stop: () => Promise<void>;
}

/** The SDK's push stream, narrowed the same way. */
interface PcmSink {
  write: (chunk: ArrayBuffer) => void;
  close: () => void;
}

export function useLiveDictation(options: LiveDictationOptions): LiveDictation {
  const { candidates, onSegment, onAudio, onError, onStart } = options;

  const [streamState, setStreamState] = useState<DictationState>("idle");
  const [mode, setMode] = useState<DictationMode | null>(null);
  const [latched, setLatched] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [partial, setPartial] = useState("");

  // The SDK module is long-lived; the TOKEN is not, and that is the change
  // #49's review asked for. A credential is minted per press and settled when
  // the stream stops, so the reservation behind it (lib/fast/speechMeter.ts)
  // matches one utterance instead of standing open for ten minutes.
  const sdkRef = useRef<SpeechSdk | null>(null);
  const tokenRef = useRef<HeldToken | null>(null);
  const warmRef = useRef<Promise<void> | null>(null);

  // performance.now() at the press that opened the live session, or 0 when
  // there is no reservation outstanding.
  const streamedRef = useRef(0);
  const endReasonRef = useRef<string>("user");
  // The unmount effect has an empty dependency list on purpose (it must run
  // once, at the end), so it reads the settler through a ref rather than
  // capturing the first render's copy.
  const settleRef = useRef<
    (held: HeldToken | null, spokenMs: number, reason: string) => Promise<void>
  >(async () => {});
  const sessionHandleRef = useRef<LiveSession | null>(null);
  const partialRef = useRef("");
  const pressedAtRef = useRef(0);
  // The finger came up before the socket was open. Same forgiving rule the
  // batch mic uses: a release with nothing to release LATCHES, because the
  // first-ever press puts a permission prompt in the middle of it and a
  // recording that ended the instant it began is a lost sentence.
  const pendingLatchRef = useRef(false);
  const tickRef = useRef<number | null>(null);
  const capRef = useRef<number | null>(null);
  // Which recogniser the CURRENT session is using; null between dictations.
  // This is the per-press decision — `mode` is only its shadow, kept for the
  // UI after a session ends so labels do not flicker on the way to idle.
  const activeRef = useRef<ActiveMode | null>(null);
  // True while beginStream is in its async gap, so a second press cannot open
  // a second socket.
  const startingRef = useRef(false);
  // Guards that same gap: a cancel or a stop that lands while the socket is
  // still opening must not be undone by the start that finishes afterwards.
  const sessionRef = useRef(0);

  // ── The microphone this hook owns ───────────────────────────────────────
  const captureRef = useRef<MicCapture | null>(null);
  const sinkRef = useRef<PcmSink | null>(null);
  // Audio produced between the gesture and the push stream existing. The mic
  // opens first BY DESIGN (that is the fix), so the first ~200ms of a sentence
  // arrives before there is anywhere to put it. Held here and flushed the
  // instant the stream exists, because that audio is the first word.
  const pendingPcmRef = useRef<ArrayBuffer[]>([]);
  // Has Azure said ANYTHING back on this session? The deaf-socket watchdog's
  // whole question.
  const heardRef = useRef(false);
  const watchdogRef = useRef<number | null>(null);
  // `latched` for the watchdogs, which run outside a render.
  const latchedRef = useRef(false);
  useEffect(() => {
    latchedRef.current = latched;
  }, [latched]);

  const candidatesRef = useRef(candidates);
  const onSegmentRef = useRef(onSegment);
  const onAudioRef = useRef(onAudio);
  const onErrorRef = useRef(onError);
  const onStartRef = useRef(onStart);
  useEffect(() => {
    candidatesRef.current = candidates;
    onSegmentRef.current = onSegment;
    onAudioRef.current = onAudio;
    onErrorRef.current = onError;
    onStartRef.current = onStart;
  }, [candidates, onSegment, onAudio, onError, onStart]);

  // ── The batch mic, owned ────────────────────────────────────────────────
  // Always constructed (hooks cannot be called conditionally) and only driven
  // when streaming is unavailable. Its onStart is deliberately NOT wired: this
  // hook already cleared the error at press time, and doing it twice would
  // wipe a message the fallback itself had just put up.
  // A microphone this hook already opened, waiting for the batch mic to take
  // it. Set on the way into every fallback; consumed once, by useDictation.
  const handOffRef = useRef<MediaStream | null>(null);
  const adopt = useCallback((): MediaStream | null => {
    const stream = handOffRef.current;
    handOffRef.current = null;
    return stream;
  }, []);

  const batch = useDictation({ onAudio, onError, adopt });
  const batchRef = useRef(batch);
  useEffect(() => {
    batchRef.current = batch;
  }, [batch]);

  // A batch dictation is over when its hook goes back to idle. Releasing the
  // slot here is what lets the NEXT press try streaming again.
  useEffect(() => {
    if (activeRef.current === "batch" && batch.state === "idle") activeRef.current = null;
  }, [batch.state]);

  const clearTimers = useCallback(() => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    if (capRef.current !== null) window.clearTimeout(capRef.current);
    tickRef.current = null;
    capRef.current = null;
  }, []);

  const clearWatchdogs = useCallback(() => {
    if (watchdogRef.current !== null) window.clearInterval(watchdogRef.current);
    watchdogRef.current = null;
  }, []);

  /**
   * Give the batch mic the microphone this press already opened.
   *
   * Call this on the way into any fallback. It keeps the tracks alive and
   * parks them for useDictation's `adopt`, so one press opens one microphone
   * however many recognisers it goes through.
   */
  const handOffCapture = useCallback(() => {
    handOffRef.current = captureRef.current?.detachStream() ?? null;
  }, []);

  /** Let the microphone and the push stream go. */
  const closeCapture = useCallback(() => {
    const capture = captureRef.current;
    captureRef.current = null;
    sinkRef.current?.close();
    sinkRef.current = null;
    pendingPcmRef.current = [];
    capture?.close();
  }, []);

  /**
   * Give a reservation back.
   *
   * `keepalive` because the commonest moment to call this is a stream ending
   * as the tab goes away, and a fetch the browser cancels on unload is a
   * reservation reaped at its full thirty seconds instead of billed for the
   * four that were actually spoken. Failures are swallowed: the reaper is the
   * backstop, and an error here must never become an error on screen.
   */
  const settleToken = useCallback(async (held: HeldToken | null, spokenMs: number, reason: string) => {
    if (!held?.sessionId) return;
    try {
      await fetch("/api/fast/speech-settle", {
        method: "POST",
        headers: await jsonAuthHeaders(),
        keepalive: true,
        body: JSON.stringify({
          sessionId: held.sessionId,
          seconds: Math.max(0, Math.round(spokenMs / 1000)),
          reason
        })
      });
    } catch {
      /* the reaper collects what never settles */
    }
  }, []);

  /**
   * Load the SDK. No credential, no reservation, nothing spent.
   *
   * Safe on mount, which is the point: the recogniser is ~500KB and fetching
   * it while somebody reads the pills makes the first press feel like the
   * fifth. What must NOT happen on mount is the mint — see below.
   */
  const preload = useCallback(async (): Promise<void> => {
    if (sdkRef.current) return;
    // Dynamically imported so the recogniser is not in the bundle every
    // /fast visitor downloads to type a word.
    sdkRef.current = await import("microsoft-cognitiveservices-speech-sdk");
  }, []);

  /**
   * Load the SDK and hold a valid token.
   *
   * Called from the PRESS, never from mount. #49 called this on mount and it
   * was the review's finding: opening /fast bought a ten-minute Azure Speech
   * JWT, so roughly nine minutes of recognition authority were issued to
   * anybody who came to type a word and never touched the mic.
   *
   * A token that is still comfortably alive is reused — a second quickie
   * thirty seconds after the first should not pay for a round trip — but it
   * carries its own reservation, and `settleToken` closes that one before this
   * mints the next. So the ledger holds one utterance at a time whichever way
   * the token goes.
   */
  const warm = useCallback(async (): Promise<void> => {
    await preload();
    const held = tokenRef.current;
    if (held && Date.now() < held.expiresAt - AZURE_TOKEN_REFRESH_MS) return;
    if (held) {
      tokenRef.current = null;
      void settleToken(held, 0, "unknown");
    }
    const res = await fetch("/api/fast/speech-token", {
      method: "POST",
      headers: await authHeaders()
    });
    if (!res.ok) throw new Error(`speech-token ${res.status}`);
    const payload = (await res.json()) as {
      token?: string;
      region?: string;
      expiresInMs?: number;
      sessionId?: string | null;
    };
    if (!payload.token || !payload.region) throw new Error("speech-token incomplete");
    tokenRef.current = {
      token: payload.token,
      region: payload.region,
      expiresAt: Date.now() + (payload.expiresInMs ?? 0),
      sessionId: payload.sessionId ?? null
    };
  }, [preload, settleToken]);

  useEffect(() => {
    settleRef.current = settleToken;
  }, [settleToken]);

  /** One warm-up at a time, and a failed one does not poison the next press. */
  const ensureWarm = useCallback((): Promise<void> => {
    if (!warmRef.current) {
      warmRef.current = warm().catch((e: unknown) => {
        warmRef.current = null;
        throw e;
      });
    }
    return warmRef.current;
  }, [warm]);

  // Preload the SDK on mount — and ONLY the SDK.
  //
  // #49 warmed the token here too, and that was the hole: a page view is not a
  // press, and it was buying ten minutes of Azure recognition authority from
  // anybody who opened /fast to type a word. Fetching the module costs
  // bandwidth and nothing else, so it stays; the credential moved to the press
  // (lib/fast/speechMeter.ts has the whole note).
  useEffect(() => {
    if (!candidatesRef.current) return; // an unstreamable pair: load nothing
    void preload().catch(() => {});
  }, [preload]);

  /** Fold one recogniser event in: move the tail, hand finals to the caller. */
  const apply = useCallback((event: TranscriptEvent) => {
    const next = stepTranscript(partialRef.current, event);
    partialRef.current = next.partial;
    setPartial(next.partial);
    if (next.commit) onSegmentRef.current(next.commit);
  }, []);

  /** Let go of the recogniser and the microphone it opened. */
  const teardown = useCallback(() => {
    clearTimers();
    clearWatchdogs();
    closeCapture();
    const handle = sessionHandleRef.current;
    sessionHandleRef.current = null;
    activeRef.current = null;
    handle?.close();
    // The reservation closes with the socket. Measured from the PRESS rather
    // than from the socket opening, which over-reports by the handshake — the
    // honest direction, since the SQL caps what a client claims but has no way
    // to catch one that claims too little.
    if (streamedRef.current) {
      const held = tokenRef.current;
      const spokenMs = performance.now() - streamedRef.current;
      streamedRef.current = 0;
      tokenRef.current = null; // one reservation per utterance; the next press mints
      void settleToken(held, spokenMs, endReasonRef.current);
      endReasonRef.current = "user";
    }
    heardRef.current = false;
    partialRef.current = "";
    setPartial("");
    setSeconds(0);
    setLatched(false);
    setStreamState("idle");
  }, [clearTimers, clearWatchdogs, closeCapture, settleToken]);

  /** Hand this press to the batch mic, carrying over a release it missed. */
  const fallBackToBatch = useCallback(() => {
    activeRef.current = "batch";
    setMode("batch");
    setStreamState("idle");
    batchRef.current.press();
    // The finger already came up while we were trying to stream. The batch
    // hook is still resolving getUserMedia, so its own pending-latch rule
    // takes this and keeps listening until the next tap — the forgiving read,
    // and the one that never leaves somebody talking to a mic that closed.
    if (pendingLatchRef.current) {
      pendingLatchRef.current = false;
      batchRef.current.release();
    }
  }, []);

  /**
   * A watchdog fired before anybody had said anything — the iPhone case.
   *
   * Nothing has been heard, so nothing can be lost: close the whole streaming
   * attempt down and hand the SAME press to the batch mic, including whether
   * the finger is still on the button. The person sees a mic that took a
   * moment to think, which is the point.
   */
  const recoverToBatch = useCallback(() => {
    const wasLatched = latchedRef.current;
    sessionRef.current += 1; // orphan a recogniser still in flight
    startingRef.current = false;
    // Before teardown, which would otherwise stop the tracks: the graph is
    // dead but the microphone behind it is perfectly good, and MediaRecorder
    // does not need Web Audio at all.
    handOffCapture();
    teardown();
    if (wasLatched) pendingLatchRef.current = true;
    fallBackToBatch();
  }, [fallBackToBatch, handOffCapture, teardown]);

  /**
   * The socket went deaf mid-sentence: keep the mic, drop the recogniser.
   *
   * The capture stays open and keeps retaining PCM, so what has already been
   * said is still in hand. Releasing posts the lot as one WAV through the
   * caller's ordinary upload. Restarting into the batch mic here would have
   * thrown away the four seconds that DIAGNOSED the problem.
   */
  const beginSalvage = useCallback(() => {
    if (!captureRef.current) return;
    clearWatchdogs();
    // Orphan the recogniser before letting go of it: a partial that arrives
    // after this point describes audio the WAV also contains, and committing
    // both would put the same words in the box twice.
    sessionRef.current += 1;
    const handle = sessionHandleRef.current;
    sessionHandleRef.current = null;
    sinkRef.current?.close();
    sinkRef.current = null;
    if (handle) {
      void handle
        .stop()
        .catch(() => {})
        .finally(() => handle.close());
    }
    activeRef.current = "salvage";
    setMode("batch"); // it is the lumpy mic now, and should be labelled as one
    partialRef.current = "";
    setPartial("");
  }, [clearWatchdogs]);

  /** Post what the salvaged capture heard, or drop it on a cancel. */
  const finishSalvage = useCallback(
    (cancelled: boolean) => {
      const capture = captureRef.current;
      clearTimers();
      clearWatchdogs();
      const wav = cancelled ? null : (capture?.toWav() ?? null);
      closeCapture();
      activeRef.current = null;
      heardRef.current = false;
      partialRef.current = "";
      setPartial("");
      setSeconds(0);
      setLatched(false);
      if (!wav) {
        setStreamState("idle");
        return;
      }
      setStreamState("working");
      void onAudioRef.current(wav, "audio/wav").finally(() => setStreamState("idle"));
    },
    [clearTimers, clearWatchdogs, closeCapture]
  );

  const stopStream = useCallback(
    (cancelled: boolean) => {
      // The 30s cap and the stop button both come through here, and by then
      // this press may have become a salvage. Same gesture, different ending.
      if (activeRef.current === "salvage") {
        finishSalvage(cancelled);
        return;
      }
      const handle = sessionHandleRef.current;
      if (!handle) return;
      clearTimers();
      clearWatchdogs();
      // "working" for the flush. Azure emits a final for the trailing audio on
      // stop, so this is the window in which the last word of the sentence
      // actually arrives — and the button must not invite a second press
      // while it does.
      setStreamState("working");
      void handle
        .stop()
        .catch(() => {})
        .finally(() => {
          apply({ type: cancelled ? "cancel" : "stop" });
          teardown();
        });
    },
    [apply, clearTimers, clearWatchdogs, finishSalvage, teardown]
  );

  /**
   * Watch a started session for the two failures that do not throw.
   *
   * Both are armed only AFTER the recogniser reports itself started, because
   * before that the connect timeout owns the press.
   */
  const armWatchdog = useCallback(
    (session: number) => {
      const startedAt = performance.now();
      // Polled rather than timed, because one of the two clocks micVerdict
      // reads is measured in VOICED AUDIO and not in wall time — somebody who
      // presses the mic and then thinks has not found a bug.
      watchdogRef.current = window.setInterval(() => {
        if (session !== sessionRef.current) return;
        const capture = captureRef.current;
        if (!capture) return;
        const verdict = micVerdict({
          frames: capture.frames(),
          voicedMs: capture.voicedMs(),
          sinceStartMs: performance.now() - startedAt,
          heard: heardRef.current
        });
        if (verdict === "streaming") return;
        if (verdict === "dead-graph") recoverToBatch();
        else beginSalvage();
      }, WATCHDOG_POLL_MS);
    },
    [beginSalvage, recoverToBatch]
  );

  /**
   * Open a live recognition session, or throw so the caller can fall back.
   *
   * The microphone is already open when this runs — `press` opened it inside
   * the user gesture, which is the whole point (lib/fast/micCapture.ts), and
   * left the handle in `captureRef`. What is left to fail here is the SDK, the
   * token, and the socket.
   */
  const beginStream = useCallback(
    async (session: number): Promise<void> => {
      const locales = candidatesRef.current;
      if (!locales || locales.length === 0) throw new Error("pair not streamable");
      const capture = captureRef.current;
      if (!capture) throw new Error("no microphone");
      // A refused microphone throws here, and the batch mic is then the thing
      // that says so — it asks again and surfaces the denial in words.
      await capture.started;
      await ensureWarm();
      const sdk = sdkRef.current;
      const held = tokenRef.current;
      if (!sdk || !held) throw new Error("speech unavailable");
      if (session !== sessionRef.current) throw new Error("superseded");

      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(held.token, held.region);
      // Our own PCM, not the SDK's microphone. See the header: letting it open
      // the mic is what made this a dead button on an iPhone.
      const sink = sdk.AudioInputStream.createPushStream(
        sdk.AudioStreamFormat.getWaveFormatPCM(SPEECH_SAMPLE_RATE, 16, 1)
      );
      const audioConfig = sdk.AudioConfig.fromStreamInput(sink);
      let recognizer: InstanceType<SpeechSdk["SpeechRecognizer"]>;
      if (locales.length === 1) {
        // ONE language: no language identification at all, and this is the
        // fast path rather than an edge case. Measured against the same clip,
        // first words land in ~800ms here and ~2400ms with LID on
        // (lib/fast/speechLocale.ts carries the table). It is what a pinned
        // direction buys, and it is most of the difference between a mic that
        // feels live and one that feels merely quick.
        speechConfig.speechRecognitionLanguage = locales[0];
        recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      } else {
        // CONTINUOUS identification, chosen on measurement and not on the name
        // — 2.4s to first word against at-start's 3.8s, for the same two
        // candidates and an identical transcript. At-start buffers ~3 seconds
        // to decide once, which is exactly the thing this screen cannot spend.
        speechConfig.setProperty(
          sdk.PropertyId.SpeechServiceConnection_LanguageIdMode,
          SPEECH_LANGUAGE_ID_MODE
        );
        recognizer = sdk.SpeechRecognizer.FromConfig(
          speechConfig,
          sdk.AutoDetectSourceLanguageConfig.fromLanguages([...locales]),
          audioConfig
        );
      }

      // Anything Azure says at all proves the socket is two-way: stand both
      // watchdogs down and let the retained copy go, since there is now a
      // live transcript and nothing to salvage.
      const heard = (): void => {
        if (heardRef.current) return;
        heardRef.current = true;
        clearWatchdogs();
        captureRef.current?.stopRetaining();
      };
      recognizer.recognizing = (_s, e) => {
        if (session !== sessionRef.current) return;
        heard();
        apply({ type: "partial", text: e.result.text ?? "" });
      };
      recognizer.recognized = (_s, e) => {
        if (session !== sessionRef.current) return;
        if (e.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
        heard();
        apply({ type: "final", text: e.result.text ?? "" });
      };
      // The socket died mid-sentence: an expired token, a tunnel, a walk out
      // of wifi range. Whatever was already finalized is in the box and stays
      // there — this ends the session rather than restarting it, because a mic
      // that silently reconnects is a mic that bills for audio nobody knows it
      // is still sending. The next press mints a fresh token and tries again,
      // and if Azure is still unreachable that press lands in batch.
      recognizer.canceled = (_s, e) => {
        if (session !== sessionRef.current) return;
        if (e.reason === sdk.CancellationReason.Error) {
          // The token is the likeliest culprit and the cheapest thing to fix.
          tokenRef.current = null;
          warmRef.current = null;
          onErrorRef.current("Lost the mic — tap to try again.");
        }
        apply({ type: "stop" });
        teardown();
      };

      // The handshake, with a clock on it. The SDK puts none on its own, so a
      // captive portal or a stalled tunnel would otherwise hold the button lit
      // for as long as the TCP stack allowed.
      await new Promise<void>((resolve, reject) => {
        const bell = window.setTimeout(() => {
          reject(new Error("connect timeout"));
        }, STREAM_CONNECT_MS);
        recognizer.startContinuousRecognitionAsync(
          () => {
            window.clearTimeout(bell);
            resolve();
          },
          (err: string) => {
            window.clearTimeout(bell);
            reject(new Error(err));
          }
        );
      }).catch((e: unknown) => {
        try {
          recognizer.close();
        } catch {
          /* a recogniser that never opened has nothing to close */
        }
        throw e;
      });

      // Superseded while the socket was opening (a cancel, or an unmount).
      // Close it rather than leaving a paid recogniser listening to a room.
      if (session !== sessionRef.current) {
        recognizer.close();
        throw new Error("superseded");
      }

      // Only now does audio have somewhere to go — and the first words of the
      // sentence were spoken before this existed, so they are flushed first.
      sinkRef.current = sink;
      for (const chunk of pendingPcmRef.current) sink.write(chunk);
      pendingPcmRef.current = [];

      sessionHandleRef.current = {
        close: () => recognizer.close(),
        stop: () =>
          new Promise<void>((resolve) => {
            recognizer.stopContinuousRecognitionAsync(
              () => resolve(),
              () => resolve()
            );
          })
      };
      activeRef.current = "stream";
      // The reservation is now outstanding; teardown() closes it.
      streamedRef.current = pressedAtRef.current || performance.now();
      endReasonRef.current = "user";

      partialRef.current = "";
      setPartial("");
      setMode("stream");
      setStreamState("recording");
      setSeconds(0);
      if (pendingLatchRef.current) {
        pendingLatchRef.current = false;
        setLatched(true);
      }
      armWatchdog(session);
      tickRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
      // The hard stop, and it is a GENTLE one: it ends the session the same
      // way letting go does, so the thirty seconds already heard are kept and
      // translated. A cap that discarded them would punish somebody for
      // talking too long by throwing away what they said. setTimeout and not
      // the tick, because a throttled background tab stretches an interval
      // and this is a spend bound (streaming STT bills per audio-second).
      capRef.current = window.setTimeout(() => {
        endReasonRef.current = "cap";
        stopStream(false);
      }, FAST_MAX_DICTATION_MS);
    },
    [apply, armWatchdog, clearWatchdogs, ensureWarm, stopStream, teardown]
  );

  const press = useCallback(() => {
    const active = activeRef.current;
    // A press during a running dictation is the tap that ends it. The batch
    // hook makes that call itself; the stream path is ended here.
    if (active === "batch") {
      batchRef.current.press();
      return;
    }
    if (active === "stream" || active === "salvage") {
      stopStream(false);
      return;
    }
    // One dictation at a time — including the flush at the end of the last one
    // and the async gap at the start of this one.
    if (startingRef.current || streamState === "working") return;
    if (batchRef.current.state === "working") return;

    onStartRef.current?.();
    pressedAtRef.current = performance.now();
    pendingLatchRef.current = false;

    // A pair Azure cannot hear never attempts a socket. Straight to batch, no
    // token spent, no delay in front of the mic.
    if (!candidatesRef.current) {
      fallBackToBatch();
      return;
    }

    // ── THE GESTURE ─────────────────────────────────────────────────────────
    // Nothing may be awaited before this line. openMicCapture constructs the
    // AudioContext, resumes it and calls getUserMedia synchronously, because
    // an iPhone will only honour all three inside the tap's own task — and a
    // context it refuses is a mic that looks alive and hears nothing. See
    // lib/fast/micCapture.ts for the whole story.
    heardRef.current = false;
    pendingPcmRef.current = [];
    try {
      captureRef.current = openMicCapture({
        onPcm: (chunk) => {
          const sink = sinkRef.current;
          if (sink) sink.write(chunk);
          else pendingPcmRef.current.push(chunk);
        },
        // Kept only until the first hypothesis proves the socket is two-way.
        // Until then it is the sentence a deaf socket would otherwise cost.
        retain: true
      });
    } catch {
      // No Web Audio at all. The batch mic needs none of it.
      fallBackToBatch();
      return;
    }

    startingRef.current = true;
    const session = (sessionRef.current += 1);
    void beginStream(session)
      .catch(() => {
        if (session !== sessionRef.current) return;
        // Silent, by design. See the header: the batch mic is a real mode, not
        // an error state, and the person holding the phone is mid-errand. The
        // microphone this press already opened goes WITH it — two live
        // captures on a phone is how you get one that records silence, and so
        // is closing one and immediately asking for another.
        handOffCapture();
        closeCapture();
        fallBackToBatch();
      })
      .finally(() => {
        if (session === sessionRef.current) startingRef.current = false;
      });
  }, [beginStream, closeCapture, fallBackToBatch, handOffCapture, streamState, stopStream]);

  const release = useCallback(() => {
    if (activeRef.current === "batch") {
      batchRef.current.release();
      return;
    }
    // The socket is still opening (or the permission prompt is up). Latch when
    // it lands; a release with nothing to release is never a stop.
    if (activeRef.current !== "stream" && activeRef.current !== "salvage") {
      pendingLatchRef.current = true;
      return;
    }
    if (performance.now() - pressedAtRef.current < TAP_MS) {
      setLatched(true); // a tap — keep listening until the next one
      return;
    }
    stopStream(false);
  }, [stopStream]);

  const cancel = useCallback(() => {
    if (activeRef.current === "batch") {
      batchRef.current.cancel();
      return;
    }
    if (activeRef.current === "stream" || activeRef.current === "salvage") {
      stopStream(true);
      return;
    }
    // Nothing has committed yet — orphan whatever session is still opening so
    // the start that lands afterwards closes its own socket, and let go of the
    // microphone it already opened.
    sessionRef.current += 1;
    startingRef.current = false;
    pendingLatchRef.current = false;
    clearWatchdogs();
    closeCapture();
    handOffRef.current?.getTracks().forEach((t) => t.stop());
    handOffRef.current = null;
    setStreamState("idle");
  }, [clearWatchdogs, closeCapture, stopStream]);

  // Leaving the screen mid-sentence must not leave the mic open or the socket
  // billing. The batch mic cleans itself up in its own unmount effect.
  useEffect(() => {
    return () => {
      sessionRef.current += 1;
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      if (capRef.current !== null) window.clearTimeout(capRef.current);
      if (watchdogRef.current !== null) window.clearInterval(watchdogRef.current);
      const capture = captureRef.current;
      captureRef.current = null;
      sinkRef.current?.close();
      sinkRef.current = null;
      capture?.close();
      // A microphone parked for a fallback that never happened.
      handOffRef.current?.getTracks().forEach((t) => t.stop());
      handOffRef.current = null;
      // And the reservation. `keepalive` inside settleToken is what makes this
      // survive the navigation that is unmounting us — without it the row is
      // reaped later at its full thirty seconds for a sentence that was four.
      if (streamedRef.current) {
        const held = tokenRef.current;
        const spokenMs = performance.now() - streamedRef.current;
        streamedRef.current = 0;
        tokenRef.current = null;
        void settleRef.current(held, spokenMs, "lost");
      }
      const handle = sessionHandleRef.current;
      sessionHandleRef.current = null;
      if (handle) {
        void handle
          .stop()
          .catch(() => {})
          .finally(() => handle.close());
      }
    };
  }, []);

  if (mode === "batch" && activeRef.current !== "stream" && activeRef.current !== "salvage") {
    return {
      state: batch.state,
      mode: "batch",
      latched: batch.latched,
      seconds: batch.seconds,
      partial: "", // the batch mic has no hypotheses to show
      press,
      release,
      cancel
    };
  }

  return { state: streamState, mode, latched, seconds, partial, press, release, cancel };
}
