"use client";

// WebRTC client for the realtime conversation tutor. Unlike the (deprecated)
// translator realtime path, here we PLAY the model's audio back to the learner
// and surface live transcripts over the data channel. Guardrails: a hard
// session cap and a silence auto-off keep realtime spend predictable.

import type { TutorLevel, TutorPhase } from "./types";
import {
  clockEventsBetween,
  newTurnGate,
  planSessionClock,
  requestEnd,
  turnEnded,
  turnStarted,
  type SessionClock
} from "./sessionClock";

export type ConvState =
  | "idle"
  | "requesting_mic"
  | "minting"
  | "connecting"
  | "connected"
  | "stopping"
  | "error";

export type StopReason = "user" | "cap" | "idle" | "error";

/** What the server granted this session, and what is left after it. */
export interface SessionGrant {
  /** Seconds the meter reserved. The session's real cap, whatever was asked. */
  grantedSeconds: number;
  /** Seconds left on the balance AFTER this reservation. Infinity if unlimited. */
  remainingSeconds: number;
  unlimited: boolean;
  tier: string;
  packSeconds: number;
}

export interface ConversationConfig {
  /** Catalog code of the language being learned (lib/languages/catalog.ts). */
  target: string;
  /** Catalog code of the language the learner already speaks. */
  learner: string;
  level: TutorLevel;
  /** Which part of the loop this session is: walk, run, or free partner talk. */
  phase: TutorPhase;
  /** The module in play. Absent for Conversation Partner. */
  moduleId?: string;
  focus?: string;
  maxDurationMs?: number; // hard cap; default 10 min
  idleTimeoutMs?: number; // silence auto-off; default 20 s
  authToken?: string; // Supabase access token, for the server-side trial gate
}

export interface ConversationEvents {
  onState?: (s: ConvState) => void;
  onError?: (msg: string) => void;
  onUserTranscript?: (text: string) => void; // finalized learner speech
  onAssistantDelta?: (text: string) => void; // streaming tutor text chunk
  onAssistantDone?: () => void; // tutor finished a turn
  onTick?: (elapsedSec: number) => void;
  /**
   * The meter granted this much. Fired once, right after the mint, so the UI
   * can show a session that is shorter than the 10 minutes it asked for
   * WITHOUT the learner discovering it by being cut off.
   */
  onGrant?: (grant: SessionGrant) => void;
  /** Two minutes from the end. Fired once, never repeated (see the clock). */
  onWarning?: (secondsLeft: number) => void;
  onStopped?: (reason: StopReason, elapsedSec: number) => void;
  onDebug?: (line: string) => void; // raw diagnostics for the on-screen log
}

export interface ActiveConversation {
  stop: (reason?: StopReason) => Promise<void>;
  steer: (text: string) => void;
  setMicEnabled: (on: boolean) => void;
  /**
   * Replace the client's script-position block for the rest of the session
   * (lib/tutor/beats.ts builds it). One slot, replaced rather than appended:
   * the position is a single fact, and a model handed a growing pile of
   * "beat 1 done… beat 2 done…" has to work out which line is current — the
   * exact re-derivation this whole mechanism exists to take away from it.
   */
  setScriptState: (block: string) => void;
}

const DEFAULT_MAX_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_MS = 20 * 1000;

interface MintResponse {
  sessionId?: string;
  clientSecret: string;
  callUrl: string;
  model: string;
  voice: string;
  instructions: string;
  /** False when Walk asked for a lesson the server had no cached copy of. */
  lessonAvailable?: boolean;
  /** What the meter reserved, in seconds. The session's real cap. */
  grantedSeconds?: number;
  /** Seconds before the end to warn. The server owns this number. */
  warnAtSeconds?: number;
  balance?: {
    unlimited?: boolean;
    tier?: string;
    remainingSeconds?: number;
    packSeconds?: number;
  };
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
  // Where the client says the scene is. Empty for Conversation Partner, which
  // has no script to be at a position in.
  let scriptState = "";
  // The server's id for this session (lib/tutor/meter.ts). Held so the end of
  // the call can be reported against the same id the mint was logged under —
  // phase 2 reconciles the two lines into billed minutes.
  let sessionId = "";
  // The meter's clock, replaced once the mint says what it actually granted.
  // Until then it is the client's own preference, which is a CEILING the
  // server may lower and never a floor it must honour.
  let clock: SessionClock = planSessionClock(Math.round(maxMs / 1000));
  let gate = newTurnGate();
  let lastTickSec = 0;
  const steerNotes: string[] = [];
  const startMs = Date.now();

  const setState = (s: ConvState) => events.onState?.(s);
  const elapsedSec = () => Math.round((Date.now() - startMs) / 1000);
  const dbg = (line: string) => events.onDebug?.(line);

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
    const seconds = elapsedSec();
    reportSessionEnd(reason, seconds);
    events.onStopped?.(reason, seconds);
  };

  // Tell the server the session ended, and how long it ran. keepalive so it
  // survives the tab being closed mid-call, which is exactly the case where
  // nothing else would ever record the minutes. Best effort by design: a
  // failed beacon must not keep a microphone open or surface an error to
  // someone who just hung up.
  const reportSessionEnd = (reason: StopReason, seconds: number) => {
    if (!sessionId) return;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
    try {
      void fetch("/api/tutor/session", {
        method: "POST",
        headers,
        keepalive: true,
        body: JSON.stringify({
          sessionId,
          seconds,
          reason,
          phase: config.phase,
          moduleId: config.moduleId ?? null
        })
      }).catch(() => {});
    } catch {
      /* ignore */
    }
    sessionId = "";
  };

  /**
   * The cap arrived. End at a TURN BOUNDARY, not mid-sentence.
   *
   * The thing being interrupted is a conversation in a language the learner is
   * bad at, and cutting the tutor off mid-word to save four seconds of a
   * ten-minute session is not a saving worth making. So: if the tutor is
   * speaking, hold and stop when the turn lands; if it is not, stop now,
   * because waiting would leave a paid session open until the learner happens
   * to say something. The clock's hard stop (30s later) is the backstop for a
   * turn that never finishes.
   */
  const requestCapStop = () => {
    const next = requestEnd(gate);
    gate = next.gate;
    if (next.stopNow) void stop("cap");
  };

  const bumpIdle = () => {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => void stop("idle"), idleMs);
  };

  // session.update keeps steering persistent for the rest of the call.
  const pushSessionUpdate = () => {
    if (!dc || dc.readyState !== "open") return;
    // Persona first, then where the scene is, then anything the student asked
    // for out loud. session.update REPLACES the instructions, so every part
    // has to be re-sent together or sending one silently drops the others.
    const instructions = [
      baseInstructions,
      scriptState,
      steerNotes.length > 0
        ? `Live directives from the student (follow these from now on): ${steerNotes.join(" ")}`
        : ""
    ]
      .filter(Boolean)
      .join("\n\n");
    dc.send(
      JSON.stringify({
        type: "session.update",
        session: { type: "realtime", instructions }
      })
    );
  };

  /**
   * A one-off nudge for the NEXT turn only.
   *
   * `response.instructions` REPLACES the session's instructions for that
   * response — it does not add to them. Sending a bare nudge therefore strips
   * the persona for exactly one turn, which is how a Walk scene opened with a
   * cheerful general-purpose assistant in English instead of the pharmacist's
   * first line (found driving a real session, 8/25). Everything sent this way
   * carries the persona with it.
   */
  const sendTurn = (nudge: string) => {
    if (!dc || dc.readyState !== "open") return;
    dc.send(
      JSON.stringify({
        type: "response.create",
        response: { instructions: `${baseInstructions}\n\nFor this turn only: ${nudge}` }
      })
    );
  };

  /**
   * The client moved the scene on. Pushed with session.update rather than a
   * response.create: with server VAD the model is already answering the turn
   * that triggered this, and a second response would either error as an active
   * response or talk over the learner. session.update lands on the tutor's
   * NEXT turn, which is precisely the turn that would otherwise have re-drilled
   * a finished line.
   */
  const setScriptState = (block: string) => {
    const next = block.trim();
    if (next === scriptState) return;
    scriptState = next;
    pushSessionUpdate();
  };

  const steer = (text: string) => {
    const t = text.trim();
    if (!t) return;
    steerNotes.push(t);
    pushSessionUpdate();
    // Nudge the tutor to acknowledge the change right away.
    sendTurn(`The student just asked: "${t}". Briefly acknowledge and adjust.`);
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
    sendTurn(
      config.phase === "walk"
        ? // Walk opens IN the scene. A "hello, how are you?" here would spend
          // the learner's first line on small talk the roleplay does not
          // contain.
          "Open the scene now, in character, with your first line. Do not greet the learner as a tutor and do not explain the exercise."
        : config.phase === "run"
          ? "Open in character with one short line that starts the conversation, and ask a question."
          : "Greet the student warmly in one short sentence and ask an easy opening question."
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
    const mintHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (config.authToken) mintHeaders.Authorization = `Bearer ${config.authToken}`;
    const mintRes = await fetch("/api/tutor/realtime", {
      method: "POST",
      headers: mintHeaders,
      body: JSON.stringify({
        target: config.target,
        learner: config.learner,
        level: config.level,
        phase: config.phase,
        moduleId: config.moduleId ?? null,
        focus: config.focus ?? "",
        capSeconds: Math.round(maxMs / 1000)
      })
    });
    const mint = (await mintRes.json().catch(() => ({}))) as MintResponse;
    if (!mintRes.ok || !mint.clientSecret) {
      // Map the quota gate to a friendly message.
      if (mint.error === "quota_exhausted")
        throw new Error(mint.details || "You've used this month's tutor minutes.");
      throw new Error(mint.details || mint.error || "Could not start the tutor session.");
    }
    baseInstructions = mint.instructions ?? "";
    sessionId = mint.sessionId ?? "";

    // What the meter actually reserved. A free learner with four minutes left
    // gets a four-minute session, not a ten-minute one that dies at four —
    // and the clock, the warning and the header chip all follow from this one
    // number rather than from what the client asked for.
    const granted =
      typeof mint.grantedSeconds === "number" && mint.grantedSeconds > 0
        ? mint.grantedSeconds
        : Math.round(maxMs / 1000);
    clock = planSessionClock(granted, mint.warnAtSeconds);
    const unlimited = mint.balance?.unlimited === true;
    const remaining = mint.balance?.remainingSeconds;
    events.onGrant?.({
      grantedSeconds: granted,
      remainingSeconds:
        unlimited || typeof remaining !== "number" || remaining < 0 ? Infinity : remaining,
      unlimited,
      tier: mint.balance?.tier ?? "free",
      packSeconds: mint.balance?.packSeconds ?? 0
    });
    dbg(`mint ok · model=${mint.model} voice=${mint.voice} phase=${config.phase}`);
    if (config.phase === "walk" && mint.lessonAvailable === false) {
      // The scene still runs off the module's seed; it just isn't following
      // the lesson's script. Worth saying in the debug log rather than
      // silently rehearsing lines the learner cannot see.
      dbg("walk: no cached lesson on the server — roleplay is module-only");
    }

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
      dbg(`ontrack · ${ev.track.kind} track arrived`);
      if (audioEl) {
        audioEl.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
        audioEl
          .play()
          .then(() => dbg("audio.play() ok"))
          .catch((e) => dbg(`audio.play() FAIL: ${e instanceof Error ? e.message : String(e)}`));
      }
      bumpIdle();
    };

    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      dbg(`pc: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        setState("connected");
        // Start timers once truly connected.
        if (tickTimer === null) {
          tickTimer = window.setInterval(() => {
            const e = elapsedSec();
            events.onTick?.(e);
            // Threshold CROSSINGS rather than equality: a backgrounded tab on
            // iOS fires its interval whenever the OS feels like it, and a
            // warning that only fires on the exact second is a warning that
            // does not fire.
            for (const event of clockEventsBetween(lastTickSec, e, clock)) {
              if (event === "warn") events.onWarning?.(Math.max(0, clock.endAtSeconds - e));
              else if (event === "end") requestCapStop();
              else if (event === "hard-stop") void stop("cap");
            }
            lastTickSec = e;
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
    dc.onopen = () => {
      dbg("dc open");
      maybeGreet();
    };
    dc.onmessage = ({ data }) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = typeof ev.type === "string" ? ev.type : "";

      // Log every event type. Audio deltas are noisy but their PRESENCE tells us
      // the model is actually speaking (vs. a generation problem), so keep them.
      if (type === "error") {
        dbg(`evt: error · ${JSON.stringify(ev.error ?? ev)}`);
      } else if (type === "response.done") {
        const resp = ev.response as Record<string, unknown> | undefined;
        const status = (resp?.status as string) ?? "?";
        const sd = resp?.status_details ? JSON.stringify(resp.status_details) : "";
        dbg(`evt: response.done · status=${status} ${sd}`);
      } else {
        dbg(`evt: ${type}`);
      }

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
      // The tutor started producing a turn. Tracked so the cap can wait for it
      // to land instead of cutting it off (see requestCapStop).
      if (type === "response.created") {
        gate = turnStarted(gate);
        bumpIdle();
        return;
      }
      if (
        type === "response.output_audio_transcript.delta" ||
        type === "response.audio_transcript.delta"
      ) {
        const d = typeof ev.delta === "string" ? ev.delta : "";
        if (d) events.onAssistantDelta?.(d);
        gate = turnStarted(gate);
        bumpIdle();
        return;
      }
      if (
        type === "response.output_audio_transcript.done" ||
        type === "response.audio_transcript.done" ||
        type === "response.done"
      ) {
        events.onAssistantDone?.();
        // The turn landed. If the cap arrived while the tutor was talking,
        // THIS is the moment the session was waiting for.
        const ended = turnEnded(gate);
        gate = ended.gate;
        if (ended.stopNow) {
          void stop("cap");
          return;
        }
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
    dbg(`sdp exchange: ${sdpRes.status}`);
    if (!sdpRes.ok) {
      const details = await sdpRes.text().catch(() => "");
      throw new Error(`Realtime SDP exchange failed (${sdpRes.status}). ${details}`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });

    return { stop, steer, setMicEnabled, setScriptState };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start the tutor.";
    setState("error");
    events.onError?.(message);
    await stop("error");
    throw error;
  }
}
