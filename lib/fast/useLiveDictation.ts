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
// ── Two recognisers, one button ────────────────────────────────────────────
// This hook OWNS the batch mic rather than replacing it, and decides per
// PRESS — not once per page:
//
//   stream   Azure heard both sides of the pair, the SDK loaded, the token
//            minted, the socket opened. Partials render live, finals become
//            editable text.
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
// ── What this hook does NOT do ─────────────────────────────────────────────
// It does not translate, bill, or touch the input box. It reports finalized
// segments to the caller and exposes the tentative tail, and FastShell decides
// what that means — same division as the batch mic, and the reason a spoken
// quickie still costs exactly one settled row (lib/fast/settle.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders } from "@/lib/authClient";
import { AZURE_TOKEN_REFRESH_MS, FAST_MAX_DICTATION_MS } from "@/lib/fast/dictation";
import { stepTranscript, type TranscriptEvent } from "@/lib/fast/liveTranscript";
import { TAP_MS, useDictation, type DictationState } from "@/lib/fast/useDictation";

/** Which recogniser served the current (or most recent) dictation. */
export type DictationMode = "stream" | "batch";

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
}

type SpeechSdk = typeof import("microsoft-cognitiveservices-speech-sdk");

/** The live session's handle, narrowed to what this hook needs of it. */
interface LiveSession {
  close: () => void;
  stop: () => Promise<void>;
}

export function useLiveDictation(options: LiveDictationOptions): LiveDictation {
  const { candidates, onSegment, onAudio, onError, onStart } = options;

  const [streamState, setStreamState] = useState<DictationState>("idle");
  const [mode, setMode] = useState<DictationMode | null>(null);
  const [latched, setLatched] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [partial, setPartial] = useState("");

  // Long-lived, deliberately: the SDK module and the token survive across
  // dictations so the SECOND press opens a socket with no network in front of
  // it. The first press pays one token mint (~a couple hundred ms), and the
  // warm-up effect below usually pays even that before anybody presses.
  const sdkRef = useRef<SpeechSdk | null>(null);
  const tokenRef = useRef<HeldToken | null>(null);
  const warmRef = useRef<Promise<void> | null>(null);

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
  const activeRef = useRef<DictationMode | null>(null);
  // True while beginStream is in its async gap, so a second press cannot open
  // a second socket.
  const startingRef = useRef(false);
  // Guards that same gap: a cancel or a stop that lands while the socket is
  // still opening must not be undone by the start that finishes afterwards.
  const sessionRef = useRef(0);

  const candidatesRef = useRef(candidates);
  const onSegmentRef = useRef(onSegment);
  const onErrorRef = useRef(onError);
  const onStartRef = useRef(onStart);
  useEffect(() => {
    candidatesRef.current = candidates;
    onSegmentRef.current = onSegment;
    onErrorRef.current = onError;
    onStartRef.current = onStart;
  }, [candidates, onSegment, onError, onStart]);

  // ── The batch mic, owned ────────────────────────────────────────────────
  // Always constructed (hooks cannot be called conditionally) and only driven
  // when streaming is unavailable. Its onStart is deliberately NOT wired: this
  // hook already cleared the error at press time, and doing it twice would
  // wipe a message the fallback itself had just put up.
  const batch = useDictation({ onAudio, onError });
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

  /** Load the SDK and hold a valid token. Safe to call as often as you like. */
  const warm = useCallback(async (): Promise<void> => {
    if (!sdkRef.current) {
      // Dynamically imported so the recogniser is not in the bundle every
      // /fast visitor downloads to type a word. It arrives in the background
      // after mount, or on the first press if that beats it.
      sdkRef.current = await import("microsoft-cognitiveservices-speech-sdk");
    }
    const held = tokenRef.current;
    if (held && Date.now() < held.expiresAt - AZURE_TOKEN_REFRESH_MS) return;
    const res = await fetch("/api/fast/speech-token", {
      method: "POST",
      headers: await authHeaders()
    });
    if (!res.ok) throw new Error(`speech-token ${res.status}`);
    const payload = (await res.json()) as {
      token?: string;
      region?: string;
      expiresInMs?: number;
    };
    if (!payload.token || !payload.region) throw new Error("speech-token incomplete");
    tokenRef.current = {
      token: payload.token,
      region: payload.region,
      expiresAt: Date.now() + (payload.expiresInMs ?? 0)
    };
  }, []);

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

  // Warm on mount, in the background, failures ignored. /fast is a
  // founders-only screen and the mic is its headline; paying for the SDK and
  // the token while somebody is still reading the pills makes the first press
  // as fast as the fifth. Nothing here surfaces an error — if it fails, the
  // press falls back to batch, which is what it would have done anyway.
  useEffect(() => {
    if (!candidatesRef.current) return; // an unstreamable pair: spend nothing
    void ensureWarm().catch(() => {});
  }, [ensureWarm]);

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
    const handle = sessionHandleRef.current;
    sessionHandleRef.current = null;
    activeRef.current = null;
    handle?.close();
    partialRef.current = "";
    setPartial("");
    setSeconds(0);
    setLatched(false);
    setStreamState("idle");
  }, [clearTimers]);

  const stopStream = useCallback(
    (cancelled: boolean) => {
      const handle = sessionHandleRef.current;
      if (!handle) return;
      clearTimers();
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
    [apply, clearTimers, teardown]
  );

  /**
   * Open a live recognition session, or throw so the caller can fall back.
   *
   * Everything that can fail happens BEFORE this commits to being the mic: the
   * SDK import, the token, getUserMedia, and the socket handshake are all
   * inside `startContinuousRecognitionAsync`. Once it resolves, this is the
   * mic — and `activeRef` says so.
   */
  const beginStream = useCallback(
    async (session: number): Promise<void> => {
      const locales = candidatesRef.current;
      if (!locales || locales.length === 0) throw new Error("pair not streamable");
      await ensureWarm();
      const sdk = sdkRef.current;
      const held = tokenRef.current;
      if (!sdk || !held) throw new Error("speech unavailable");
      if (session !== sessionRef.current) throw new Error("superseded");

      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(held.token, held.region);
      // AT-START language identification, said out loud because it is the
      // choice that sets the candidate cap at four rather than ten
      // (lib/fast/speechLocale.ts). A quickie is one phrase in one language;
      // continuous LID would buy the ability to change language mid-sentence
      // and pay for it in per-segment latency on the screen that cannot
      // afford any. The SDK already defaults to this — set anyway, so a
      // future default cannot quietly move the cap.
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, "AtStart");

      const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
      let recognizer: InstanceType<SpeechSdk["SpeechRecognizer"]>;
      if (locales.length === 1) {
        // Both pills resolved to the same Azure locale, so there is nothing to
        // identify BETWEEN. Ask for that language flat rather than handing a
        // one-item list to the LID machinery and paying its latency for a
        // decision with one possible answer.
        speechConfig.speechRecognitionLanguage = locales[0];
        recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      } else {
        recognizer = sdk.SpeechRecognizer.FromConfig(
          speechConfig,
          sdk.AutoDetectSourceLanguageConfig.fromLanguages([...locales]),
          audioConfig
        );
      }

      recognizer.recognizing = (_s, e) => {
        if (session !== sessionRef.current) return;
        apply({ type: "partial", text: e.result.text ?? "" });
      };
      recognizer.recognized = (_s, e) => {
        if (session !== sessionRef.current) return;
        if (e.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
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

      await new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(
          () => resolve(),
          (err: string) => reject(new Error(err))
        );
      });

      // Superseded while the socket was opening (a cancel, or an unmount).
      // Close it rather than leaving a paid recogniser listening to a room.
      if (session !== sessionRef.current) {
        recognizer.close();
        throw new Error("superseded");
      }

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

      partialRef.current = "";
      setPartial("");
      setMode("stream");
      setStreamState("recording");
      setSeconds(0);
      if (pendingLatchRef.current) {
        pendingLatchRef.current = false;
        setLatched(true);
      }
      tickRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
      // The hard stop, and it is a GENTLE one: it ends the session the same
      // way letting go does, so the thirty seconds already heard are kept and
      // translated. A cap that discarded them would punish somebody for
      // talking too long by throwing away what they said. setTimeout and not
      // the tick, because a throttled background tab stretches an interval
      // and this is a spend bound (streaming STT bills per audio-second).
      capRef.current = window.setTimeout(() => stopStream(false), FAST_MAX_DICTATION_MS);
    },
    [apply, ensureWarm, stopStream, teardown]
  );

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

  const press = useCallback(() => {
    const active = activeRef.current;
    // A press during a running dictation is the tap that ends it. The batch
    // hook makes that call itself; the stream path is ended here.
    if (active === "batch") {
      batchRef.current.press();
      return;
    }
    if (active === "stream") {
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

    startingRef.current = true;
    const session = (sessionRef.current += 1);
    void beginStream(session)
      .catch(() => {
        if (session !== sessionRef.current) return;
        // Silent, by design. See the header: the batch mic is a real mode, not
        // an error state, and the person holding the phone is mid-errand.
        fallBackToBatch();
      })
      .finally(() => {
        if (session === sessionRef.current) startingRef.current = false;
      });
  }, [beginStream, fallBackToBatch, streamState, stopStream]);

  const release = useCallback(() => {
    if (activeRef.current === "batch") {
      batchRef.current.release();
      return;
    }
    // The socket is still opening (or the permission prompt is up). Latch when
    // it lands; a release with nothing to release is never a stop.
    if (activeRef.current !== "stream") {
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
    if (activeRef.current === "stream") {
      stopStream(true);
      return;
    }
    // Nothing has committed yet — orphan whatever session is still opening so
    // the start that lands afterwards closes its own socket.
    sessionRef.current += 1;
    startingRef.current = false;
    pendingLatchRef.current = false;
    setStreamState("idle");
  }, [stopStream]);

  // Leaving the screen mid-sentence must not leave the mic open or the socket
  // billing. The batch mic cleans itself up in its own unmount effect.
  useEffect(() => {
    return () => {
      sessionRef.current += 1;
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      if (capRef.current !== null) window.clearTimeout(capRef.current);
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

  if (mode === "batch" && activeRef.current !== "stream") {
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
