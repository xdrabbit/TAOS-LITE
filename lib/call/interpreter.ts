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
  let idleTimer: number | null = null;
  let idleWarnTimer: number | null = null;
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
  // Speech segment timing, for the transcription half of the bill. The API
  // reports these in milliseconds against the session's own audio clock.
  let speechStartedMs: number | null = null;

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

  const clearTimers = () => {
    if (capTimer !== null) window.clearTimeout(capTimer);
    if (audioStuckTimer !== null) window.clearTimeout(audioStuckTimer);
    capTimer = null;
    audioStuckTimer = null;
    clearIdleTimers();
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
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.src = "";
      audioEl.remove();
    }
    setAudioPlaying(false);
    setState("idle");
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

  const setMuted = (next: boolean) => {
    muted = next;
    if (audioEl) audioEl.muted = next;
  };

  const setDirection = (next: CallDirection) => {
    direction = next;
    if (stopped || !dc || dc.readyState !== "open") return;
    dc.send(
      JSON.stringify({
        type: "session.update",
        session: { type: "realtime", instructions: buildCallInterpreterInstructions(next) }
      })
    );
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
      // — the captions already said everything there is to say.
      if (!blob || stopped || muted) return;
      await new Promise<void>((resolve) => {
        if (!audioEl) {
          resolve();
          return;
        }
        const url = URL.createObjectURL(blob);
        const done = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
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
      body: JSON.stringify({ ...direction, mode: voiceMode })
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

    // Feed the remote partner's audio straight into the interpreter session.
    pc.addTrack(config.inputTrack, new MediaStream([config.inputTrack]));

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === "connected") {
        setState("connected");
        if (capTimer === null) {
          capTimer = window.setTimeout(() => {
            events.onAutoEnd?.("max_duration");
            void stop();
          }, maxMs);
        }
        bumpIdle();
      }
      if (pc.connectionState === "failed") {
        events.onError?.("Interpreter connection failed.");
        void stop();
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
    dc.onerror = () => events.onError?.("Interpreter data channel error.");

    setState("connecting");
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

    return { stop, setMuted, setDirection, spend: () => spend };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start the interpreter.";
    setState("error");
    events.onError?.(message);
    await stop();
    throw error;
  }
}
