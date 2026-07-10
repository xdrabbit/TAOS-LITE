"use client";

// WebRTC client for /live "Ambient AI" mode. Streams the mic continuously to a
// GA Realtime session (minted by POST /api/live/realtime) whose only job is to
// speak/write micro-summaries of the surrounding conversation in the target
// language. Connection pattern mirrors lib/tutor/conversation.ts (the proven
// path); differences: no greeting, no steering, output audio is mutable
// ("voice off" = text-only), and the idle window is long enough for a quiet
// stretch of a movie.

export type AmbientState =
  | "idle"
  | "requesting_mic"
  | "minting"
  | "connecting"
  | "connected"
  | "stopping"
  | "error";

export type AmbientTarget = "en" | "es";
export type AmbientStopReason = "user" | "cap" | "idle" | "error";

export interface AmbientConfig {
  target: AmbientTarget;
  /** Start with output audio muted (text-only). */
  muted?: boolean;
  /** Hard session cap; default 2 h — a long dinner. */
  maxDurationMs?: number;
  /** Auto-off after this long with no detected speech; default 5 min. */
  idleTimeoutMs?: number;
}

export interface AmbientEvents {
  onState?: (s: AmbientState) => void;
  onError?: (msg: string) => void;
  /** Finalized transcription of what the mic picked up (source language). */
  onHeard?: (text: string) => void;
  /** Streaming chunk of the current micro-summary. */
  onSummaryDelta?: (delta: string) => void;
  /** The micro-summary finished; `text` is the full transcript of it. */
  onSummaryDone?: (text: string) => void;
  onTick?: (elapsedSec: number) => void;
  onStopped?: (reason: AmbientStopReason, elapsedSec: number) => void;
}

export interface ActiveAmbientSession {
  stop: (reason?: AmbientStopReason) => Promise<void>;
  setMuted: (muted: boolean) => void;
}

const DEFAULT_MAX_MS = 2 * 60 * 60 * 1000;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

interface MintResponse {
  clientSecret: string;
  callUrl: string;
  model: string;
  voice: string;
  error?: string;
  details?: string;
}

export async function startAmbientLive(
  config: AmbientConfig,
  events: AmbientEvents
): Promise<ActiveAmbientSession> {
  const maxMs = config.maxDurationMs ?? DEFAULT_MAX_MS;
  const idleMs = config.idleTimeoutMs ?? DEFAULT_IDLE_MS;

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let localStream: MediaStream | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let tickTimer: number | null = null;
  let idleTimer: number | null = null;
  let stopped = false;
  // Accumulates transcript deltas so onSummaryDone can fall back to them if the
  // done event ever arrives without a transcript payload.
  let summaryBuffer = "";
  // Response gating (the session is minted with create_response: false).
  // Server-auto-created responses overlapped: a new summary's audio started
  // while the previous one was still draining out of the WebRTC buffer. So WE
  // create responses: a turn increments `pendingTurns` only once its input
  // transcription confirms real words (VAD noise-triggers must not spawn
  // hallucinated summaries), and the next response fires when the previous one
  // has finished BOTH generating (response.done) and playing
  // (output_audio_buffer.stopped). Everything pending is coalesced into one
  // fresh summary.
  let pendingTurns = 0;
  let responseActive = false;
  let audioPlaying = false;
  let audioStuckTimer: number | null = null;
  const startMs = Date.now();

  const setState = (s: AmbientState) => events.onState?.(s);
  const elapsedSec = () => Math.round((Date.now() - startMs) / 1000);

  const clearTimers = () => {
    if (tickTimer !== null) window.clearInterval(tickTimer);
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    if (audioStuckTimer !== null) window.clearTimeout(audioStuckTimer);
    tickTimer = null;
    idleTimer = null;
    audioStuckTimer = null;
  };

  const stop = async (reason: AmbientStopReason = "user") => {
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
      if (pc) {
        pc.getSenders().forEach((sn) => sn.track?.stop());
        pc.close();
      }
    } catch {
      /* ignore */
    }
    localStream?.getTracks().forEach((t) => t.stop());
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
    }
    setState("idle");
    events.onStopped?.(reason, elapsedSec());
  };

  const bumpIdle = () => {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => void stop("idle"), idleMs);
  };

  const setMuted = (muted: boolean) => {
    if (audioEl) audioEl.muted = muted;
  };

  const clearAudioStuckTimer = () => {
    if (audioStuckTimer !== null) window.clearTimeout(audioStuckTimer);
    audioStuckTimer = null;
  };

  // Fire the next micro-summary if there is committed speech waiting and the
  // previous summary is fully finished. Called from every gate-state change.
  const maybeRespond = () => {
    if (stopped || pendingTurns === 0 || responseActive || audioPlaying) return;
    if (!dc || dc.readyState !== "open") return;
    pendingTurns = 0; // everything committed so far is covered by this response
    responseActive = true;
    dc.send(JSON.stringify({ type: "response.create" }));
  };

  try {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      !window.isSecureContext
    ) {
      throw new Error(
        "Microphone is unavailable here. Open the app over HTTPS in Safari/Chrome and allow mic access."
      );
    }

    setState("requesting_mic");
    // noiseSuppression OFF: it's tuned to isolate one near-field voice and
    // eats the far-side dinner/TV audio we actually want. echoCancellation
    // stays ON — it only subtracts what this device plays, so it stops the
    // session from hearing (and re-summarizing) its own voice on speaker
    // without touching external audio. autoGainControl boosts quiet speakers.
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false
      }
    });

    setState("minting");
    const mintRes = await fetch("/api/live/realtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: config.target })
    });
    const mint = (await mintRes.json().catch(() => ({}))) as MintResponse;
    if (!mintRes.ok || !mint.clientSecret) {
      throw new Error(mint.details || mint.error || "Could not start the live session.");
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
          /* user gesture already happened on START; a failure here is benign */
        });
      }
      bumpIdle();
    };

    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === "connected") {
        setState("connected");
        if (tickTimer === null) {
          tickTimer = window.setInterval(() => {
            events.onTick?.(elapsedSec());
            if (Date.now() - startMs >= maxMs) void stop("cap");
          }, 1000);
        }
        bumpIdle();
      }
      if (pc.connectionState === "failed") {
        events.onError?.("Live connection failed.");
        void stop("error");
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
        bumpIdle();
        return;
      }
      // VAD finished a turn and committed its audio to the conversation. Do
      // NOT count it as pending yet — wait for its transcription below. VAD
      // false-triggers (coughs, clinks, room noise) commit audio whose
      // transcript comes back empty, and summarizing those made the model
      // hallucinate content into the silence.
      if (type === "input_audio_buffer.committed") {
        bumpIdle();
        return;
      }
      if (type === "response.done") {
        responseActive = false;
        // Over WebRTC the audio can still be draining; output_audio_buffer
        // events release that side of the gate. Belt-and-braces: if the
        // "stopped" event never arrives, unstick after 12s (summaries are
        // capped well below that).
        if (audioPlaying) {
          clearAudioStuckTimer();
          audioStuckTimer = window.setTimeout(() => {
            audioPlaying = false;
            maybeRespond();
          }, 12_000);
        }
        maybeRespond();
        return;
      }
      if (type === "output_audio_buffer.started") {
        audioPlaying = true;
        bumpIdle();
        return;
      }
      if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
        audioPlaying = false;
        clearAudioStuckTimer();
        maybeRespond();
        bumpIdle();
        return;
      }
      if (type === "conversation.item.input_audio_transcription.completed") {
        const t = typeof ev.transcript === "string" ? ev.transcript.trim() : "";
        // Only turns with real words become pending summaries. Requiring some
        // letters/digits filters the "…"/"[inaudible]"-style junk transcripts
        // that noise-triggered turns produce.
        if (t && /[\p{L}\p{N}]{2,}/u.test(t)) {
          events.onHeard?.(t);
          pendingTurns += 1;
          maybeRespond();
        }
        bumpIdle();
        return;
      }
      if (
        type === "response.output_audio_transcript.delta" ||
        type === "response.audio_transcript.delta"
      ) {
        const d = typeof ev.delta === "string" ? ev.delta : "";
        if (d) {
          summaryBuffer += d;
          events.onSummaryDelta?.(d);
        }
        bumpIdle();
        return;
      }
      if (
        type === "response.output_audio_transcript.done" ||
        type === "response.audio_transcript.done"
      ) {
        const t =
          (typeof ev.transcript === "string" && ev.transcript.trim()) || summaryBuffer.trim();
        summaryBuffer = "";
        if (t) events.onSummaryDone?.(t);
        bumpIdle();
        return;
      }
      if (type === "error") {
        const err = ev.error as Record<string, unknown> | undefined;
        const msg = (err && typeof err.message === "string" && err.message) || "Realtime error.";
        events.onError?.(msg);
      }
    };
    dc.onerror = () => events.onError?.("Live data channel error.");

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
      throw new Error(`Live SDP exchange failed (${sdpRes.status}). ${details}`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });

    return { stop, setMuted };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start live mode.";
    setState("error");
    events.onError?.(message);
    await stop("error");
    throw error;
  }
}
