"use client";

import { jsonAuthHeaders } from "@/lib/authClient";
import { buildCallInterpreterInstructions, type CallDirection } from "./instructions";
import {
  addResponseUsage,
  addTranscribedSeconds,
  addTtsCharacters,
  emptySpend,
  type CallSpend,
  type RealtimeUsage
} from "./cost";
import { requestSpeech } from "@/lib/tts/speech";
import { bridgeInterpreterInput, type InterpreterInputBridge } from "./audioBridge";

// WebRTC client for the /call interpreter. Unlike lib/live/ambient.ts (which
// streams the MIC), this streams the REMOTE call partner's audio track into a
// GA Realtime session (minted by POST /api/call/realtime) that translates
// everything they say into the listener's language. Response gating is the
// proven /live pattern: the client creates responses only after the previous
// translation has finished generating AND playing, so audio never overlaps.
//
// ── Two voices, and why both are here ──────────────────────────────────────
// "clone"   — the session answers in TEXT and lib/tts/speech.ts speaks it,
//             which means the app's own voices: Liz's clone reading her own
//             sentence in English, per the voice-follows-speaker rule. It is
//             also the cheaper half of the bill by a distance (the model's
//             own audio output is $64/Mtok and the single largest line item
//             on a call). It costs roughly a second: the sentence has to
//             finish before it can be synthesised.
// "instant" — the session speaks. Lowest latency, a stock voice, most money.
//
// clone is the default because it is both cheaper and the better voice. The
// toggle stays because latency on two real phones over real cellular is the
// one thing that could not be measured before shipping this, and if it turns
// out to matter more than the voice does, quality wins — that is a one-tap
// change on the screen, not a deploy.
//
// ── What is NOT here ───────────────────────────────────────────────────────
// There is no client-side speech gate detaching the partner's track during
// silence. It was the obvious saving and it turns out to be already made:
// with server VAD on, the Realtime API bills the segments it COMMITS, not the
// stream it receives. Measured 2026-08-27 — 34s streamed into a session,
// 22.7s billed, and the difference was the silence between utterances. A
// gate would have added a way to clip the first syllable of a sentence in
// exchange for nothing.

export type InterpreterState =
  | "idle"
  | "minting"
  | "connecting"
  | "connected"
  | "stopping"
  | "error";

/** How the translation reaches the listener's ear. See the note above. */
export type InterpreterVoiceMode = "clone" | "instant";

/** Why a session ended on its own, when it did. */
export type InterpreterEndReason = "idle" | "max_duration";

export interface InterpreterConfig {
  /** Which language becomes which. `target` is what this phone's owner hears. */
  direction: CallDirection;
  /** The remote call partner's audio track (from the call peer connection). */
  inputTrack: MediaStreamTrack;
  /** Start with translated audio muted (captions only). */
  muted?: boolean;
  voiceMode?: InterpreterVoiceMode;
  /** Hard session cap. Defaults to 60 min — the API's own ceiling. */
  maxDurationMs?: number;
  /** Hang up after this long with nothing said. Defaults to 2 min. */
  idleTimeoutMs?: number;
}

/**
 * What the session is actually HEARING, as numbers rather than as an absence.
 *
 * The 2026-09-03 field report was two connected interpreters that translated
 * nothing, and there was no way to tell "the audio is silent" from "the model
 * is quiet" from "the events are not arriving" — all three look like dead
 * air. These are the three measurements that separate them.
 */
export interface InterpreterInputStats {
  /** VAD segments the session started hearing. Zero is the whole symptom. */
  speechStarted: number;
  /** Segments VAD closed and committed for transcription. */
  speechCommitted: number;
  /** Latest instantaneous level on the outbound track, or null if unreported. */
  level: number | null;
  /** Cumulative audio energy on the outbound track, or null if unreported. */
  energy: number | null;
  /** Whether the track reached the session through the WebAudio bridge. */
  bridged: boolean;
}

export interface InterpreterEvents {
  onState?: (s: InterpreterState) => void;
  onError?: (msg: string) => void;
  /** Finalized transcription of what the remote partner said (source language). */
  onHeard?: (text: string) => void;
  /** Streaming chunk of the current translation. */
  onTranslationDelta?: (delta: string) => void;
  /** The translation finished; `text` is its full transcript. */
  onTranslationDone?: (text: string) => void;
  /**
   * The interpreter's translated AUDIO started/stopped playing on THIS phone.
   * Relay it to the partner: they are the one who can talk over it (they
   * can't hear this side), so their phone shows the "hold on" indicator.
   */
  onSpeaking?: (speaking: boolean) => void;
  /** The running bill for this phone, after every response and every readout. */
  onSpend?: (spend: CallSpend) => void;
  /**
   * Nothing has been said for a while and the session will end soon unless
   * someone speaks. `secondsLeft` counts down; null clears the warning.
   */
  onIdleWarning?: (secondsLeft: number | null) => void;
  /** The session closed itself rather than being hung up. */
  onAutoEnd?: (reason: InterpreterEndReason) => void;
  /**
   * Whether the partner's audio is actually REACHING the session.
   *
   * "Connected" is not the same question. The interpreter is fed the remote
   * call partner's WebRTC track, forwarded out of the call's own peer
   * connection into this one, and a forwarded track that carries silence
   * looks identical to a healthy one from every angle the client can see:
   * the peer connection is connected, the data channel is open, no error is
   * ever raised, and nothing happens for the rest of the call. This flips
   * true the first time server VAD reports speech, which is the only proof
   * available that the far end's voice arrived — and it stays false, visibly,
   * when it does not.
   */
  onHearing?: (hearing: boolean) => void;
  /**
   * One line of interpreter trail — the input level, the speech-segment count.
   * Same surface as the call's own diagnostics, and for the same reason: the
   * next silent interpreter should be readable, not guessable.
   */
  onDiagnostic?: (line: string) => void;
  /**
   * Connected for a while, hearing nothing, and the numbers agree. Distinct
   * from the idle warning: idle means nobody spoke, this means somebody may
   * well have and none of it reached the session.
   */
  onInputSilent?: () => void;
}

export interface ActiveInterpreter {
  stop: () => Promise<void>;
  setMuted: (muted: boolean) => void;
  /**
   * Re-point the interpreter without tearing the session down — either phone
   * can change its language mid-call, and the partner's phone finds out over
   * the call's signaling channel.
   */
  setDirection: (direction: CallDirection) => void;
  /** The bill so far, for the hang-up report. */
  spend: () => CallSpend;
  /** What the session heard, for the hang-up report and the log line. */
  inputStats: () => InterpreterInputStats;
}

/**
 * 60 minutes, which is also the Realtime API's own maximum session duration —
 * a longer cap here would just be a promise the provider breaks. The old
 * value was four hours, which is not a cap, it is a rounding error on a
 * forgotten tab.
 */
const DEFAULT_MAX_MS = 60 * 60 * 1000;

/**
 * Two minutes of nobody saying anything ends the call. A translated call
 * left face-down on a table bills two sessions for as long as the tab lives,
 * and the phone that forgot about it is the phone least likely to notice.
 * The last 30 seconds are warned about on screen, and any speech at all —
 * either direction — resets the whole thing.
 */
const DEFAULT_IDLE_MS = 2 * 60 * 1000;
const IDLE_WARNING_MS = 30 * 1000;

/**
 * How long the session gets to finish connecting before the screen is told it
 * failed.
 *
 * `onconnectionstatechange` reports "connected" and "failed" and nothing in
 * between, and a peer connection that never negotiates a working candidate
 * pair can sit in "connecting" for the better part of a minute before the
 * browser gives up — or, if the data channel is the half that never opens,
 * for the whole call. Both look the same to the person holding the phone:
 * nothing. 15s, the same watchdog the call itself got in PR #52, for the same
 * reason — a failure nobody is told about is indistinguishable from a feature
 * that does not work.
 */
const CONNECT_TIMEOUT_MS = 15_000;
/** How often the input measurement is taken once the session is connected. */
const INPUT_POLL_MS = 2000;
/**
 * How long a connected session may hear literally nothing before the screen
 * says so. Long enough that two people greeting each other is not a warning,
 * short enough that nobody sits through the two-minute idle timeout wondering.
 */
const SILENT_INPUT_AFTER_MS = 20_000;
/**
 * Below these, the outbound track is carrying silence rather than a quiet
 * room. `totalAudioEnergy` is cumulative, so even a whisper twenty seconds
 * ago clears it; a track sending empty frames never does.
 */
const SILENT_LEVEL = 0.001;
const SILENT_ENERGY = 1e-6;

interface MintResponse {
  clientSecret: string;
  callUrl: string;
  model: string;
  voice: string;
  mode: InterpreterVoiceMode;
  error?: string;
  details?: string;
}

export async function startCallInterpreter(
  config: InterpreterConfig,
  events: InterpreterEvents
): Promise<ActiveInterpreter> {
  const maxMs = config.maxDurationMs ?? DEFAULT_MAX_MS;
  const idleMs = config.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const voiceMode: InterpreterVoiceMode = config.voiceMode ?? "clone";

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let capTimer: number | null = null;
  let connectTimer: number | null = null;
  let idleTimer: number | null = null;
  let idleWarnTimer: number | null = null;
  // Flipped by the first speech VAD commits. See `onHearing` above: it is the
  // difference between a session that is connected and a session that is
  // being fed anything at all.
  let hearing = false;
  // Set by `fail` below. `stop()` runs on the way out of every failure, and
  // it used to finish by announcing "idle" — so the screen was told the
  // interpreter had failed and then, three lines later, told it was simply
  // not running. An error that is overwritten by its own cleanup is an error
  // nobody sees.
  let failedReason: string | null = null;
  let stopped = false;
  let muted = Boolean(config.muted);
  let direction = config.direction;
  let spend = emptySpend("elevenlabs");
  // Accumulates transcript deltas so onTranslationDone can fall back to them
  // if the done event ever arrives without a transcript payload.
  let translationBuffer = "";
  // Response gating (the session is minted with create_response: false). A
  // turn increments `pendingTurns` only once its input transcription confirms
  // real words (VAD noise-triggers must not spawn hallucinated translations),
  // and the next response fires when the previous one has finished BOTH
  // generating (response.done) and playing (output_audio_buffer.stopped, or
  // the readout's own "ended" in clone mode).
  let pendingTurns = 0;
  let responseActive = false;
  let audioPlaying = false;
  let audioStuckTimer: number | null = null;
  // The object URL of the readout currently loaded into the audio element, and
  // the settle function of the promise waiting on it. Both exist so that
  // silencing the phone can tear down a readout mid-sentence WITHOUT leaving
  // speakTranslation's promise unresolved — an unresolved one never reaches
  // its `finally`, and the response gate it is holding stays held for the rest
  // of the call.
  let currentReadoutUrl: string | null = null;
  let readoutDone: (() => void) | null = null;
  // Bumped by every change to the output mode. A readout that was already
  // being synthesised when the listener tapped carries the generation it
  // started in; if that no longer matches, it drops itself instead of
  // arriving a second after the tap that cancelled it.
  let outputGeneration = 0;
  // Speech segment timing, for the transcription half of the bill. The API
  // reports these in milliseconds against the session's own audio clock.
  let speechStartedMs: number | null = null;
  // The WebAudio re-origination of the partner's track (see audioBridge.ts),
  // and the input measurements taken off the session's own sender.
  let inputBridge: InterpreterInputBridge | null = null;
  let statsTimer: number | null = null;
  let connectedAt: number | null = null;
  let speechStartedCount = 0;
  let speechCommittedCount = 0;
  let inputLevel: number | null = null;
  let inputEnergy: number | null = null;
  let silenceReported = false;

  const setState = (s: InterpreterState) => events.onState?.(s);
  const publishSpend = () => events.onSpend?.(spend);

  // Single funnel for the audio-playing flag so every transition (started,
  // stopped, cleared, unstick fallback, stop) reaches onSpeaking exactly once.
  const setAudioPlaying = (playing: boolean) => {
    if (audioPlaying === playing) return;
    audioPlaying = playing;
    events.onSpeaking?.(playing);
  };

  const clearIdleTimers = () => {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    if (idleWarnTimer !== null) window.clearTimeout(idleWarnTimer);
    idleTimer = null;
    idleWarnTimer = null;
  };

  const clearConnectTimer = () => {
    if (connectTimer !== null) window.clearTimeout(connectTimer);
    connectTimer = null;
  };

  const clearTimers = () => {
    if (capTimer !== null) window.clearTimeout(capTimer);
    if (audioStuckTimer !== null) window.clearTimeout(audioStuckTimer);
    if (statsTimer !== null) window.clearInterval(statsTimer);
    capTimer = null;
    audioStuckTimer = null;
    statsTimer = null;
    clearConnectTimer();
    clearIdleTimers();
  };

  const inputStats = (): InterpreterInputStats => ({
    speechStarted: speechStartedCount,
    speechCommitted: speechCommittedCount,
    level: inputLevel,
    energy: inputEnergy,
    bridged: inputBridge !== null
  });

  /** Compact enough to sit on the same trail as the call's own lines. */
  const fmt = (n: number | null, places: number) => (n === null ? "?" : n.toFixed(places));

  /**
   * Read what the interpreter's own sender says it is sending.
   *
   * `media-source` is the honest one — it measures the track before it is
   * encoded — but Safari has not always published it, so `outbound-rtp`
   * stands in. A browser that reports neither leaves both null, and the
   * silence warning below stays quiet rather than accusing it of anything.
   */
  const readInputStats = async () => {
    if (stopped || !pc || typeof pc.getStats !== "function") return;
    // Collected into an object rather than into four `let`s: values written
    // from inside a callback are not narrowed by the compiler afterwards.
    const seen: {
      sourceLevel: number | null;
      sourceEnergy: number | null;
      rtpLevel: number | null;
      rtpEnergy: number | null;
    } = { sourceLevel: null, sourceEnergy: null, rtpLevel: null, rtpEnergy: null };
    try {
      const report = await pc.getStats();
      report.forEach((raw) => {
        const stat = raw as Record<string, unknown>;
        const kind = typeof stat.kind === "string" ? stat.kind : stat.mediaType;
        if (kind !== "audio") return;
        const level = typeof stat.audioLevel === "number" ? stat.audioLevel : null;
        const energy = typeof stat.totalAudioEnergy === "number" ? stat.totalAudioEnergy : null;
        if (stat.type === "media-source") {
          seen.sourceLevel = level ?? seen.sourceLevel;
          seen.sourceEnergy = energy ?? seen.sourceEnergy;
        } else if (stat.type === "outbound-rtp") {
          seen.rtpLevel = level ?? seen.rtpLevel;
          seen.rtpEnergy = energy ?? seen.rtpEnergy;
        }
      });
    } catch {
      return;
    }
    if (stopped) return;
    const level = seen.sourceLevel ?? seen.rtpLevel;
    const energy = seen.sourceEnergy ?? seen.rtpEnergy;
    if (level !== null) inputLevel = level;
    if (energy !== null) inputEnergy = energy;
    events.onDiagnostic?.(
      `interp in level=${fmt(level, 3)} energy=${fmt(energy, 2)}` +
        ` speech_started=${speechStartedCount} bridged=${inputBridge !== null}`
    );

    // Only ever accuse the input when there is a number to accuse it with.
    // No reported level AND no reported energy is an old WebKit, not silence.
    if (
      silenceReported ||
      connectedAt === null ||
      speechStartedCount > 0 ||
      (level === null && energy === null) ||
      Date.now() - connectedAt < SILENT_INPUT_AFTER_MS
    ) {
      return;
    }
    if ((level ?? 0) < SILENT_LEVEL && (energy ?? 0) < SILENT_ENERGY) {
      silenceReported = true;
      events.onInputSilent?.();
    }
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    setState("stopping");
    clearTimers();
    events.onIdleWarning?.(null);
    try {
      if (dc && dc.readyState !== "closed") dc.close();
    } catch {
      /* ignore */
    }
    try {
      // Do NOT stop() sender tracks here — the input track belongs to the
      // call's peer connection and must keep flowing to the human listener.
      pc?.close();
    } catch {
      /* ignore */
    }
    // The bridge's nodes and its minted track ARE ours, and a call that is
    // hung up and re-made must not leave a graph behind each time.
    inputBridge?.release();
    inputBridge = null;
    if (audioEl) {
      audioEl.pause();
      // Settle a readout that is still in the air, for the same reason
      // stopSpokenAudio does: an unresolved promise never reaches its
      // `finally`, and hang-up should not leave one pending.
      readoutDone?.();
      audioEl.srcObject = null;
      audioEl.src = "";
      audioEl.remove();
    }
    setAudioPlaying(false);
    setState(failedReason ? "error" : "idle");
  };

  /**
   * End the session and leave the reason standing.
   *
   * Every path that gives up goes through here so that exactly one thing is
   * true afterwards: the screen holds a state of "error" and a sentence
   * saying why. Idempotent — the first reason wins, because the first one is
   * the cause and the ones after it are consequences.
   */
  const fail = (message: string) => {
    if (failedReason) return;
    failedReason = message;
    setState("error");
    events.onError?.(message);
    void stop();
  };

  // Any real speech, in either direction, means the call is alive.
  const bumpIdle = () => {
    if (stopped) return;
    clearIdleTimers();
    events.onIdleWarning?.(null);
    idleWarnTimer = window.setTimeout(() => {
      events.onIdleWarning?.(Math.round(IDLE_WARNING_MS / 1000));
    }, Math.max(0, idleMs - IDLE_WARNING_MS));
    idleTimer = window.setTimeout(() => {
      events.onAutoEnd?.("idle");
      void stop();
    }, idleMs);
  };

  /**
   * Silence whatever this phone is saying RIGHT NOW.
   *
   * Muting the element is not enough on its own, and that was the field
   * report: in clone mode the element goes on playing the mp3 inaudibly for
   * its full length, holding the response gate behind a sentence nobody can
   * hear; in instant mode the model's speech is already sitting in the
   * session's output buffer, where an element property cannot reach it.
   */
  const stopSpokenAudio = () => {
    // Clone mode: an mp3 blob is loaded in the element. Settle the waiting
    // promise BEFORE tearing the element down, then drop the blob.
    if (audioEl && currentReadoutUrl) {
      audioEl.pause();
      readoutDone?.();
      audioEl.removeAttribute("src");
      // Abandon the blob load before its URL is revoked; without this WebKit
      // holds the reference and reports a media error against the next src.
      audioEl.load();
    }
    // Instant mode: the element is rendering a live WebRTC track, so it must
    // NOT be torn down (there would be nothing to restore it with). The queued
    // speech lives on the server; only the server can drop it. This is what
    // makes "instant" stop mid-word rather than finish the sentence.
    if (voiceMode === "instant" && audioPlaying && dc && dc.readyState === "open") {
      try {
        dc.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
      } catch {
        /* the channel is already closing, which silences it anyway */
      }
    }
  };

  /**
   * Turn the translated voice off or on, effective immediately.
   *
   * "Immediately" is the whole point. This used to set two flags and leave the
   * sentence in the air to finish on its own, so a tap during a six-second
   * translation looked like a control that did nothing — and a tap back the
   * other way did nothing either, because the readout it would have restored
   * had already decided not to play. Both directions now take effect on the
   * sentence in front of the listener, not the one after it.
   */
  const setMuted = (next: boolean) => {
    if (muted === next) return;
    muted = next;
    // Everything already in flight belongs to the mode just left.
    outputGeneration += 1;
    if (audioEl) audioEl.muted = next;
    if (next) {
      stopSpokenAudio();
      // Release the gate the abandoned readout was holding, or the next
      // translation politely waits out a sentence that is no longer playing.
      setAudioPlaying(false);
      maybeRespond();
    }
  };

  /**
   * Re-point the session mid-call, or remember to as soon as it can be.
   *
   * `direction` used to move first and the send was allowed to fall through:
   * before the data channel opens — the ~1s mint-and-connect window a tap can
   * easily land in — the model kept its ORIGINAL instructions while this
   * phone's local direction had already moved. The two sides then disagreed
   * silently, and nothing ever retried, so the session stayed pointed the
   * wrong way for the rest of the call.
   *
   * So the local direction only moves when the update is actually on the
   * wire; otherwise the change is parked and `flushDirection` applies both
   * together the moment the channel opens.
   */
  let pendingDirection: CallDirection | null = null;

  const sendDirection = (next: CallDirection): boolean => {
    if (stopped || !dc || dc.readyState !== "open") return false;
    try {
      dc.send(
        JSON.stringify({
          type: "session.update",
          session: { type: "realtime", instructions: buildCallInterpreterInstructions(next) }
        })
      );
    } catch {
      // A channel that is open-but-closing throws here. Treat it as not sent,
      // so the direction stays parked rather than silently diverging.
      return false;
    }
    return true;
  };

  const setDirection = (next: CallDirection) => {
    if (sendDirection(next)) {
      direction = next;
      pendingDirection = null;
      return;
    }
    // Not sent. Park it and leave `direction` where the session still is.
    pendingDirection = next;
  };

  /** Data channel open: apply anything that arrived before it was usable. */
  const flushDirection = () => {
    const next = pendingDirection;
    if (!next) return;
    if (sendDirection(next)) {
      direction = next;
      pendingDirection = null;
    }
  };

  const clearAudioStuckTimer = () => {
    if (audioStuckTimer !== null) window.clearTimeout(audioStuckTimer);
    audioStuckTimer = null;
  };

  // Fire the next translation if committed speech is waiting and the previous
  // translation is fully finished. Called from every gate-state change.
  const maybeRespond = () => {
    if (stopped || pendingTurns === 0 || responseActive || audioPlaying) return;
    if (!dc || dc.readyState !== "open") return;
    pendingTurns = 0; // everything committed so far is covered by this response
    responseActive = true;
    dc.send(JSON.stringify({ type: "response.create" }));
  };

  /**
   * Speak a finished translation through the app's own voices.
   *
   * `sourceLanguage` is the language the PARTNER spoke, which is what picks
   * the clone: the voice follows the SPEAKER, so Liz talking Spanish comes
   * out of Tom's phone as Liz's voice speaking English (lib/tts/voice.ts).
   *
   * The gate is held from before the request until playback ends, so the next
   * translation cannot start generating while this one is still in the air —
   * exactly the guarantee the realtime path gets from output_audio_buffer.
   */
  const speakTranslation = async (text: string) => {
    if (stopped || !text.trim()) return;
    // Voice off means NO SYNTHESIS, not synthesis nobody hears. This check
    // used to sit after the request came back, so a call with the voice turned
    // off went on paying ElevenLabs $0.05 per 1,000 characters for every
    // translation, for as long as the call lasted. What "text only" leaves the
    // listener is the captions, and the captions are free.
    if (muted) return;
    const generation = outputGeneration;
    setAudioPlaying(true);
    try {
      const blob = await requestSpeech(
        {
          text,
          sourceLanguage: direction.source,
          targetLanguage: direction.target,
          // The same trade /live makes: on a live call, a voice that arrives
          // late is worse than a voice with slightly less character.
          latency: "flash"
        },
        { failureMessage: "Interpreter voice failed." }
      );
      spend = addTtsCharacters(spend, text.length);
      publishSpend();
      // null is "this language has no voice" (tier 2, lib/languages/catalog.ts)
      // — the captions already said everything there is to say. The generation
      // check is the toggle: a sentence synthesised under the old mode must
      // not start playing under the new one, a second after the tap.
      if (!blob || stopped || muted || generation !== outputGeneration) return;
      await new Promise<void>((resolve) => {
        if (!audioEl) {
          resolve();
          return;
        }
        const url = URL.createObjectURL(blob);
        currentReadoutUrl = url;
        const done = () => {
          // Idempotent: `ended`, `error` and a mid-sentence silence can all
          // reach it, and only the first may settle the promise.
          if (readoutDone !== done) return;
          readoutDone = null;
          if (audioEl) {
            audioEl.onended = null;
            audioEl.onerror = null;
          }
          if (currentReadoutUrl === url) {
            URL.revokeObjectURL(url);
            currentReadoutUrl = null;
          }
          resolve();
        };
        readoutDone = done;
        audioEl.onended = done;
        audioEl.onerror = done;
        audioEl.srcObject = null;
        audioEl.src = url;
        void audioEl.play().catch(done);
      });
    } catch {
      // A dead voice service must not take the captions down with it.
      events.onError?.("Interpreter voice failed — captions are still running.");
    } finally {
      setAudioPlaying(false);
      maybeRespond();
    }
  };

  try {
    setState("minting");
    const mintRes = await fetch("/api/call/realtime", {
      method: "POST",
      headers: await jsonAuthHeaders(),
      body: JSON.stringify({
        source: direction.source,
        target: direction.target,
        mode: voiceMode
      })
    });
    const mint = (await mintRes.json().catch(() => ({}))) as MintResponse;
    if (!mintRes.ok || !mint.clientSecret) {
      throw new Error(mint.details || mint.error || "Could not start the interpreter.");
    }

    pc = new RTCPeerConnection();

    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.muted = muted;
    (audioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    // Only "instant" mode has a track to receive; in clone mode the same
    // element plays the mp3 blobs /api/tts hands back.
    pc.ontrack = (ev) => {
      if (audioEl && voiceMode === "instant") {
        audioEl.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
        audioEl.play().catch(() => {
          /* user gesture already happened when answering the call */
        });
      }
    };

    // Feed the remote partner's audio into the interpreter session THROUGH a
    // WebAudio graph. Handing the received track to `addTrack` directly is
    // what /call did until 2026-09-03, and on iOS Safari it sends silence —
    // see the note at the top of lib/call/audioBridge.ts. A locally generated
    // destination track is the same audio in a form Safari will actually
    // transmit; where there is no WebAudio, the raw track is still better
    // than no interpreter.
    inputBridge = bridgeInterpreterInput(config.inputTrack);
    if (inputBridge) {
      pc.addTrack(inputBridge.track, inputBridge.stream);
    } else {
      events.onDiagnostic?.("interp input bridge unavailable — sending the raw track");
      pc.addTrack(config.inputTrack, new MediaStream([config.inputTrack]));
    }

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === "connected") {
        clearConnectTimer();
        setState("connected");
        if (capTimer === null) {
          capTimer = window.setTimeout(() => {
            events.onAutoEnd?.("max_duration");
            void stop();
          }, maxMs);
        }
        if (statsTimer === null) {
          connectedAt = Date.now();
          void readInputStats();
          statsTimer = window.setInterval(() => void readInputStats(), INPUT_POLL_MS);
        }
        bumpIdle();
      }
      if (pc.connectionState === "failed") {
        clearConnectTimer();
        fail("The interpreter lost its connection.");
      }
    };

    dc = pc.createDataChannel("oai-events");
    dc.onmessage = ({ data }) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = typeof ev.type === "string" ? ev.type : "";

      if (type === "input_audio_buffer.speech_started") {
        speechStartedMs = typeof ev.audio_start_ms === "number" ? ev.audio_start_ms : null;
        // The partner's forwarded audio demonstrably arrived. Said once.
        if (!hearing) {
          hearing = true;
          events.onHearing?.(true);
        }
        // The count is the answer to "is the session hearing anything at
        // all?". It ends up on the trail and in the [taos-call-cost] line,
        // because a call that translated nothing has to say WHY in the log.
        speechStartedCount += 1;
        events.onDiagnostic?.(`interp speech_started=${speechStartedCount}`);
        return;
      }
      if (type === "input_audio_buffer.committed") {
        speechCommittedCount += 1;
        return;
      }
      if (type === "input_audio_buffer.speech_stopped") {
        // The seconds transcription actually bills for: what VAD committed,
        // not what the microphone streamed.
        const endMs = typeof ev.audio_end_ms === "number" ? ev.audio_end_ms : null;
        if (speechStartedMs !== null && endMs !== null && endMs > speechStartedMs) {
          spend = addTranscribedSeconds(spend, (endMs - speechStartedMs) / 1000);
          publishSpend();
        }
        speechStartedMs = null;
        return;
      }

      if (type === "response.done") {
        responseActive = false;
        const response = ev.response as { usage?: RealtimeUsage } | undefined;
        spend = addResponseUsage(spend, response?.usage);
        publishSpend();
        // Over WebRTC the audio can still be draining; output_audio_buffer
        // events release that side of the gate. Belt-and-braces: if the
        // "stopped" event never arrives, unstick after 20s (translations are
        // longer than ambient summaries, but never that long). Clone mode
        // holds its own gate around the readout instead.
        if (audioPlaying && voiceMode === "instant") {
          clearAudioStuckTimer();
          audioStuckTimer = window.setTimeout(() => {
            setAudioPlaying(false);
            maybeRespond();
          }, 20_000);
        }
        maybeRespond();
        return;
      }
      if (type === "output_audio_buffer.started") {
        setAudioPlaying(true);
        return;
      }
      if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
        setAudioPlaying(false);
        clearAudioStuckTimer();
        maybeRespond();
        return;
      }
      if (type === "conversation.item.input_audio_transcription.completed") {
        const t = typeof ev.transcript === "string" ? ev.transcript.trim() : "";
        // Only turns with real words become pending translations; filters the
        // "…"/"[inaudible]" junk that noise-triggered turns produce.
        if (t && /[\p{L}\p{N}]{2,}/u.test(t)) {
          events.onHeard?.(t);
          bumpIdle();
          pendingTurns += 1;
          maybeRespond();
        }
        return;
      }
      if (
        type === "response.output_audio_transcript.delta" ||
        type === "response.audio_transcript.delta" ||
        type === "response.output_text.delta" ||
        type === "response.text.delta"
      ) {
        const d = typeof ev.delta === "string" ? ev.delta : "";
        if (d) {
          translationBuffer += d;
          events.onTranslationDelta?.(d);
        }
        return;
      }
      if (
        type === "response.output_audio_transcript.done" ||
        type === "response.audio_transcript.done" ||
        type === "response.output_text.done" ||
        type === "response.text.done"
      ) {
        const finished =
          (typeof ev.transcript === "string" && ev.transcript.trim()) ||
          (typeof ev.text === "string" && ev.text.trim()) ||
          translationBuffer.trim();
        translationBuffer = "";
        if (finished) {
          events.onTranslationDone?.(finished);
          bumpIdle();
          if (voiceMode === "clone") void speakTranslation(finished);
        }
        return;
      }
      if (type === "error") {
        const err = ev.error as Record<string, unknown> | undefined;
        const msg = (err && typeof err.message === "string" && err.message) || "Realtime error.";
        events.onError?.(msg);
      }
    };
    dc.onopen = flushDirection; // apply a direction parked during the mint
    dc.onerror = () => events.onError?.("Interpreter data channel error.");

    setState("connecting");
    // The watchdog for every way this can hang rather than fail: a candidate
    // pair that never forms, a data channel that never opens, a provider that
    // accepts the SDP and then says nothing. `failed` covers none of them.
    connectTimer = window.setTimeout(() => {
      if (stopped || pc?.connectionState === "connected") return;
      fail(`The interpreter could not connect (stuck at "${pc?.connectionState ?? "new"}").`);
    }, CONNECT_TIMEOUT_MS);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpRes = await fetch(mint.callUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${mint.clientSecret}`, "Content-Type": "application/sdp" },
      body: offer.sdp ?? ""
    });
    if (!sdpRes.ok) {
      const details = await sdpRes.text().catch(() => "");
      throw new Error(`Interpreter SDP exchange failed (${sdpRes.status}). ${details}`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });

    return { stop, setMuted, setDirection, spend: () => spend, inputStats };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start the interpreter.";
    fail(message);
    throw error;
  }
}
