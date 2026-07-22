"use client";

// WebRTC client for the /call interpreter. Unlike lib/live/ambient.ts (which
// streams the MIC), this streams the REMOTE call partner's audio track into a
// GA Realtime session (minted by POST /api/call/realtime) that speaks/writes a
// faithful translation in the listener's language. Response gating is the
// proven /live pattern: the client creates responses only after the previous
// translation has finished generating AND playing, so audio never overlaps.

export type InterpreterState =
  | "idle"
  | "minting"
  | "connecting"
  | "connected"
  | "stopping"
  | "error";

export type InterpreterTarget = "en" | "es";

export interface InterpreterConfig {
  /** The language the LISTENER wants to hear (what remote speech becomes). */
  target: InterpreterTarget;
  /** The remote call partner's audio track (from the call peer connection). */
  inputTrack: MediaStreamTrack;
  /** Start with translated audio muted (captions only). */
  muted?: boolean;
  /** Hard session cap; default 4 h — longer than any call. */
  maxDurationMs?: number;
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
}

export interface ActiveInterpreter {
  stop: () => Promise<void>;
  setMuted: (muted: boolean) => void;
}

const DEFAULT_MAX_MS = 4 * 60 * 60 * 1000;

interface MintResponse {
  clientSecret: string;
  callUrl: string;
  model: string;
  voice: string;
  error?: string;
  details?: string;
}

export async function startCallInterpreter(
  config: InterpreterConfig,
  events: InterpreterEvents
): Promise<ActiveInterpreter> {
  const maxMs = config.maxDurationMs ?? DEFAULT_MAX_MS;

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let capTimer: number | null = null;
  let stopped = false;
  // Accumulates transcript deltas so onTranslationDone can fall back to them
  // if the done event ever arrives without a transcript payload.
  let translationBuffer = "";
  // Response gating (the session is minted with create_response: false). A
  // turn increments `pendingTurns` only once its input transcription confirms
  // real words (VAD noise-triggers must not spawn hallucinated translations),
  // and the next response fires when the previous one has finished BOTH
  // generating (response.done) and playing (output_audio_buffer.stopped).
  let pendingTurns = 0;
  let responseActive = false;
  let audioPlaying = false;
  let audioStuckTimer: number | null = null;

  const setState = (s: InterpreterState) => events.onState?.(s);

  // Single funnel for the audio-playing flag so every transition (started,
  // stopped, cleared, unstick fallback, stop) reaches onSpeaking exactly once.
  const setAudioPlaying = (playing: boolean) => {
    if (audioPlaying === playing) return;
    audioPlaying = playing;
    events.onSpeaking?.(playing);
  };

  const clearTimers = () => {
    if (capTimer !== null) window.clearTimeout(capTimer);
    if (audioStuckTimer !== null) window.clearTimeout(audioStuckTimer);
    capTimer = null;
    audioStuckTimer = null;
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    setState("stopping");
    clearTimers();
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
      audioEl.remove();
    }
    setAudioPlaying(false);
    setState("idle");
  };

  const setMuted = (muted: boolean) => {
    if (audioEl) audioEl.muted = muted;
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

  try {
    setState("minting");
    const mintRes = await fetch("/api/call/realtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: config.target })
    });
    const mint = (await mintRes.json().catch(() => ({}))) as MintResponse;
    if (!mintRes.ok || !mint.clientSecret) {
      throw new Error(mint.details || mint.error || "Could not start the interpreter.");
    }

    pc = new RTCPeerConnection();

    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.muted = Boolean(config.muted);
    (audioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    pc.ontrack = (ev) => {
      if (audioEl) {
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
          capTimer = window.setTimeout(() => void stop(), maxMs);
        }
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

      if (type === "response.done") {
        responseActive = false;
        // Over WebRTC the audio can still be draining; output_audio_buffer
        // events release that side of the gate. Belt-and-braces: if the
        // "stopped" event never arrives, unstick after 20s (translations are
        // longer than ambient summaries, but never that long).
        if (audioPlaying) {
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
          pendingTurns += 1;
          maybeRespond();
        }
        return;
      }
      if (
        type === "response.output_audio_transcript.delta" ||
        type === "response.audio_transcript.delta"
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
        type === "response.audio_transcript.done"
      ) {
        const t =
          (typeof ev.transcript === "string" && ev.transcript.trim()) || translationBuffer.trim();
        translationBuffer = "";
        if (t) events.onTranslationDone?.(t);
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

    return { stop, setMuted };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start the interpreter.";
    setState("error");
    events.onError?.(message);
    await stop();
    throw error;
  }
}
