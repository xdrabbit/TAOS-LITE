"use client";

// WebRTC client for the realtime conversation tutor. Unlike the (deprecated)
// translator realtime path, here we PLAY the model's audio back to the learner
// and surface live transcripts over the data channel. Guardrails: a hard
// session cap and a silence auto-off keep realtime spend predictable.

export type ConvState =
  | "idle"
  | "requesting_mic"
  | "minting"
  | "connecting"
  | "connected"
  | "stopping"
  | "error";

export type LearnLang = "es" | "en";
export type Level = "beginner" | "intermediate" | "advanced";
export type StopReason = "user" | "cap" | "idle" | "error";

export interface ConversationConfig {
  learn: LearnLang;
  level: Level;
  focus?: string;
  maxDurationMs?: number; // hard cap; default 10 min
  idleTimeoutMs?: number; // silence auto-off; default 20 s
}

export interface ConversationEvents {
  onState?: (s: ConvState) => void;
  onError?: (msg: string) => void;
  onUserTranscript?: (text: string) => void; // finalized learner speech
  onAssistantDelta?: (text: string) => void; // streaming tutor text chunk
  onAssistantDone?: () => void; // tutor finished a turn
  onTick?: (elapsedSec: number) => void;
  onStopped?: (reason: StopReason, elapsedSec: number) => void;
}

export interface ActiveConversation {
  stop: (reason?: StopReason) => Promise<void>;
  steer: (text: string) => void;
  setMicEnabled: (on: boolean) => void;
}

const DEFAULT_MAX_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_MS = 20 * 1000;

interface MintResponse {
  clientSecret: string;
  callUrl: string;
  model: string;
  voice: string;
  instructions: string;
  error?: string;
  details?: string;
}

export async function startConversation(
  config: ConversationConfig,
  events: ConversationEvents
): Promise<ActiveConversation> {
  const maxMs = config.maxDurationMs ?? DEFAULT_MAX_MS;
  const idleMs = config.idleTimeoutMs ?? DEFAULT_IDLE_MS;

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let localStream: MediaStream | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let tickTimer: number | null = null;
  let idleTimer: number | null = null;
  let stopped = false;
  let greeted = false;
  let baseInstructions = "";
  const steerNotes: string[] = [];
  const startMs = Date.now();

  const setState = (s: ConvState) => events.onState?.(s);
  const elapsedSec = () => Math.round((Date.now() - startMs) / 1000);

  const clearTimers = () => {
    if (tickTimer !== null) window.clearInterval(tickTimer);
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    tickTimer = null;
    idleTimer = null;
  };

  const stop = async (reason: StopReason = "user") => {
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

  // session.update keeps steering persistent for the rest of the call.
  const pushSessionUpdate = () => {
    if (!dc || dc.readyState !== "open") return;
    const instructions =
      steerNotes.length > 0
        ? `${baseInstructions}\n\nLive directives from the student (follow these from now on): ${steerNotes.join(" ")}`
        : baseInstructions;
    dc.send(
      JSON.stringify({
        type: "session.update",
        session: { type: "realtime", instructions }
      })
    );
  };

  const steer = (text: string) => {
    const t = text.trim();
    if (!t) return;
    steerNotes.push(t);
    pushSessionUpdate();
    // Nudge the tutor to acknowledge the change right away.
    if (dc && dc.readyState === "open") {
      dc.send(
        JSON.stringify({
          type: "response.create",
          response: { instructions: `The student just asked: "${t}". Briefly acknowledge and adjust.` }
        })
      );
    }
  };

  const setMicEnabled = (on: boolean) => {
    localStream?.getAudioTracks().forEach((tr) => {
      tr.enabled = on;
    });
  };

  // Greet first so the learner isn't met with silence. Fires once, as soon as
  // the data channel is open (which may be before or after "connected").
  const maybeGreet = () => {
    if (greeted || !dc || dc.readyState !== "open") return;
    greeted = true;
    dc.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions: "Greet the student warmly in one short sentence and ask an easy opening question."
        }
      })
    );
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
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { autoGainControl: true, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });

    setState("minting");
    const mintRes = await fetch("/api/tutor/realtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learn: config.learn, level: config.level, focus: config.focus ?? "" })
    });
    const mint = (await mintRes.json().catch(() => ({}))) as MintResponse;
    if (!mintRes.ok || !mint.clientSecret) {
      throw new Error(mint.details || mint.error || "Could not start the tutor session.");
    }
    baseInstructions = mint.instructions ?? "";

    pc = new RTCPeerConnection();

    // Play the tutor's voice. Created here (inside the Start gesture chain) and
    // played on track arrival; playsInline keeps iOS from going fullscreen.
    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    (audioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    // Some browsers won't play a detached media element; keep it in the DOM but
    // hidden. Removed again in cleanup.
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    pc.ontrack = (ev) => {
      if (audioEl) {
        audioEl.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
        void audioEl.play().catch(() => {});
      }
      bumpIdle();
    };

    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === "connected") {
        setState("connected");
        // Start timers once truly connected.
        if (tickTimer === null) {
          tickTimer = window.setInterval(() => {
            const e = elapsedSec();
            events.onTick?.(e);
            if (Date.now() - startMs >= maxMs) void stop("cap");
          }, 1000);
        }
        bumpIdle();
        maybeGreet();
      }
      if (pc.connectionState === "failed") {
        events.onError?.("Connection to the tutor failed.");
        void stop("error");
      }
    };

    dc = pc.createDataChannel("oai-events");
    dc.onopen = () => maybeGreet();
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
      if (type === "conversation.item.input_audio_transcription.completed") {
        const t = typeof ev.transcript === "string" ? ev.transcript.trim() : "";
        if (t) events.onUserTranscript?.(t);
        bumpIdle();
        return;
      }
      if (
        type === "response.output_audio_transcript.delta" ||
        type === "response.audio_transcript.delta"
      ) {
        const d = typeof ev.delta === "string" ? ev.delta : "";
        if (d) events.onAssistantDelta?.(d);
        bumpIdle();
        return;
      }
      if (
        type === "response.output_audio_transcript.done" ||
        type === "response.audio_transcript.done" ||
        type === "response.done"
      ) {
        events.onAssistantDone?.();
        bumpIdle();
        return;
      }
      if (type === "error") {
        const err = ev.error as Record<string, unknown> | undefined;
        const msg = (err && typeof err.message === "string" && err.message) || "Realtime error.";
        events.onError?.(msg);
      }
    };
    dc.onerror = () => events.onError?.("Data channel error.");

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
      throw new Error(`Realtime SDP exchange failed (${sdpRes.status}). ${details}`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });

    return { stop, steer, setMicEnabled };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start the tutor.";
    setState("error");
    events.onError?.(message);
    await stop("error");
    throw error;
  }
}
