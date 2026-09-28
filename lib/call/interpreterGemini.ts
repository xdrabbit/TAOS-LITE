"use client";

import { jsonAuthHeaders } from "@/lib/authClient";
import type { CallDirection } from "./instructions";
import { addGeminiTurn, addGeminiUsage, emptySpend, type CallSpend } from "./cost";
import {
  bridgeInterpreterPcm,
  ensureCallAudioContext,
  type InterpreterPcmBridge
} from "./audioBridge";
import {
  base64ToBytes,
  bytesToBase64,
  peakOfFloat,
  PCM_IN_RATE,
  PCM_OUT_RATE,
  s16ToLeBytes,
  s16leBytesToFloat,
  VOICED_PEAK
} from "./pcm";
import { createPcmPlayer, type PcmPlayer } from "./pcmPlayer";
import type {
  ActiveInterpreter,
  InterpreterConfig,
  InterpreterEvents,
  InterpreterInputStats
} from "./interpreterEngine";

// The Gemini arm of the /call bake-off (Tom, 2026-09-28): the second
// implementation of lib/call/interpreterEngine.ts, beside the OpenAI one in
// interpreter.ts.
//
// gemini-3.5-live-translate-preview translates AND speaks, in Google's
// voices. Liz's cloned voice is not used on this path — a deliberate,
// temporary evaluation choice, not a product decision.
//
// ── How it differs from the OpenAI engine ──────────────────────────────────
// Transport   a WebSocket the browser opens with a server-minted, one-use
//             token (POST /api/call/gemini), not a second RTCPeerConnection.
// Input       the partner's track, through the SAME shared AudioContext and
//             bridge module as OpenAI's (audioBridge.ts), tapped as 16 kHz
//             s16 PCM in 100 ms chunks instead of re-sent as a track.
// Output      a continuous 24 kHz PCM stream — silence included — played by
//             pcmPlayer.ts, the jitter buffer. Its policy is written there.
// Turns       there are none. Gemini streams: no VAD events, no response to
//             request, no "done". A turn here is marked by the transcripts
//             going quiet (INPUT_QUIET_MS, OUTPUT_QUIET_MS), which is what
//             gives the captions their lines and [taos-call-lag] its turns.
//
// ── One speaker per session ────────────────────────────────────────────────
// Live Translate auto-detects the source language, has no setting for it,
// and Google's guide warns it struggles with rapid language switching. So a
// session must only ever hear ONE person. That is guaranteed by what this
// file is given: `config.inputTrack` is the REMOTE partner's received track
// from the call peer connection (CallShell's onRemoteAudioTrack), and the
// only audio sent on the socket is what bridgeInterpreterPcm taps off that
// track. The phone's own microphone never reaches this file. Each phone runs
// its own session on its own partner — two sessions per call, one per
// direction, each fed exactly one speaker.
//
// ── Spend is reported unconditionally ──────────────────────────────────────
// Every session that reached "connected" fires onSessionReport when it stops
// — hang-up, idle, the hour cap, a failure, a Resync, the partner leaving.
// See InterpreterSessionReport for why this arm does not use CallShell's
// gated hang-up report.

/** Same numbers as the OpenAI engine, for the same reasons (interpreter.ts). */
const DEFAULT_MAX_MS = 60 * 60 * 1000;
const DEFAULT_IDLE_MS = 2 * 60 * 1000;
const IDLE_WARNING_MS = 30 * 1000;
const CONNECT_TIMEOUT_MS = 15_000;
const STATS_MS = 2000;
const SILENT_INPUT_AFTER_MS = 20_000;
const SILENT_PEAK = 0.001;

/**
 * The input transcript has been quiet this long: the speaker paused, and the
 * "heard" line goes up. Measured, input transcription arrives in bursts well
 * under 500 ms apart while someone talks.
 */
const INPUT_QUIET_MS = 800;
/**
 * The translation has been quiet this long (and so has the input): the
 * caption is final. Longer than the input gap because the translated speech
 * trails the speaker by ~1.5–2.5 s and its transcript arrives in step with it.
 */
const OUTPUT_QUIET_MS = 1200;
/** A turn that was heard and never translated is closed after this. */
const UNTRANSLATED_TURN_MS = 6000;
const TURN_TICK_MS = 200;

/**
 * Input backpressure: drop, never queue. At ~4.3 KB per base64 chunk this is
 * ~1.5 s of audio the socket has not sent yet. Past it the network is not
 * keeping up, and audio queued behind a slow link only arrives late —
 * which is worse, on a live call, than audio that never arrives.
 */
const MAX_SOCKET_BUFFER_BYTES = 64 * 1024;

/**
 * How long the OLD socket keeps playing out after its replacement is ready.
 *
 * Measured 2026-09-28: the server sends goAway nine minutes into a
 * connection (`timeLeft: 50s`) and drops it at ~9m50s — six forced
 * reconnects in an hour-long call. Break-then-make would leave a ~1s hole in
 * the input and cut off whatever sentence was being translated. So a goAway
 * is make-before-break: the new session is minted and set up while the old
 * one still hears the partner, input moves over the moment the new one is
 * ready, and the old one gets this long to finish the translation it was
 * already speaking before it is closed.
 */
const DRAIN_MS = 4000;

/** Socket restarts (goAway, a drop, a language change) before giving up. */
const MAX_RESTARTS_PER_MINUTE = 3;

interface MintResponse {
  token?: string;
  wsUrl?: string;
  model?: string;
  error?: string;
  details?: string;
}

interface Turn {
  /** Input transcript not yet shown as a heard line. */
  pendingIn: string;
  out: string;
  firstInAt: number | null;
  lastInAt: number | null;
  firstOutAt: number | null;
  lastOutAt: number | null;
  heardAt: number | null;
}

export async function startGeminiInterpreter(
  config: InterpreterConfig,
  events: InterpreterEvents
): Promise<ActiveInterpreter> {
  const maxMs = config.maxDurationMs ?? DEFAULT_MAX_MS;
  const idleMs = config.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const lag = config.lag;
  const now = () => performance.now();

  let ws: WebSocket | null = null;
  let socketReady = false;
  // The socket a goAway retired: still heard from, still fed until the new
  // one is ready, then closed after DRAIN_MS.
  let draining: WebSocket | null = null;
  let drainTimer: number | null = null;
  let bridge: InterpreterPcmBridge | null = null;
  let player: PcmPlayer | null = null;
  let stopped = false;
  let failedReason: string | null = null;
  let muted = Boolean(config.muted);
  let direction: CallDirection = config.direction;
  let spend: CallSpend = emptySpend("none", "gemini");
  let model = "";

  let capTimer: number | null = null;
  let connectTimer: number | null = null;
  let idleTimer: number | null = null;
  let idleWarnTimer: number | null = null;
  let statsTimer: number | null = null;
  let turnTimer: number | null = null;

  // "connected" is the first setupComplete; restarts do not reset it.
  let connectedAt: number | null = null;
  let hearing = false;
  let turnsStarted = 0;
  let heardLines = 0;
  // The session's audio clock: 100 ms per chunk the bridge PRODUCED since it
  // was built — sent or not — so it keeps time across a socket restart.
  let chunksProduced = 0;
  let chunksSent = 0;
  let chunksDropped = 0;
  let lastVoicedInputEndMs: number | null = null;
  let maxInputPeak = 0;
  let silenceReported = false;
  let restarts: number[] = [];
  let turn: Turn | null = null;

  const setState = events.onState ?? (() => {});
  const publishSpend = () => events.onSpend?.(spend);

  const inputStats = (): InterpreterInputStats => ({
    speechStarted: turnsStarted,
    speechCommitted: heardLines,
    level: bridge ? bridge.level() : null,
    energy: null,
    bridged: bridge !== null
  });

  const clearIdleTimers = () => {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    if (idleWarnTimer !== null) window.clearTimeout(idleWarnTimer);
    idleTimer = null;
    idleWarnTimer = null;
  };

  const clearTimers = () => {
    if (capTimer !== null) window.clearTimeout(capTimer);
    if (connectTimer !== null) window.clearTimeout(connectTimer);
    if (statsTimer !== null) window.clearInterval(statsTimer);
    if (turnTimer !== null) window.clearInterval(turnTimer);
    if (drainTimer !== null) window.clearTimeout(drainTimer);
    drainTimer = null;
    capTimer = null;
    connectTimer = null;
    statsTimer = null;
    turnTimer = null;
    clearIdleTimers();
  };

  const detach = (socket: WebSocket | null) => {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  };

  const closeSocket = () => {
    detach(ws);
    detach(draining);
    ws = null;
    draining = null;
    socketReady = false;
  };

  const stop = async (endedBy: string = "hangup") => {
    if (stopped) return;
    stopped = true;
    lag?.closed();
    setState("stopping");
    clearTimers();
    events.onIdleWarning?.(null);
    closeSocket();
    // The bridge's nodes are ours; the partner's track is not, and keeps
    // playing to the human listener.
    bridge?.release();
    bridge = null;
    player?.release();
    player = null;
    if (connectedAt !== null) {
      events.onSessionReport?.({
        spend,
        seconds: (now() - connectedAt) / 1000,
        inputStats: inputStats(),
        endedBy: failedReason ? "error" : endedBy
      });
    }
    setState(failedReason ? "error" : "idle");
  };

  const fail = (message: string) => {
    if (failedReason) return;
    failedReason = message;
    setState("error");
    events.onError?.(message);
    void stop("error");
  };

  const bumpIdle = () => {
    if (stopped) return;
    clearIdleTimers();
    events.onIdleWarning?.(null);
    idleWarnTimer = window.setTimeout(() => {
      events.onIdleWarning?.(Math.round(IDLE_WARNING_MS / 1000));
    }, Math.max(0, idleMs - IDLE_WARNING_MS));
    idleTimer = window.setTimeout(() => {
      events.onAutoEnd?.("idle");
      void stop("idle");
    }, idleMs);
  };

  // ── Turns ────────────────────────────────────────────────────────────────

  const emitHeard = (t: Turn) => {
    const text = t.pendingIn.trim();
    t.pendingIn = "";
    if (!text || !/[\p{L}\p{N}]{2,}/u.test(text)) return;
    const at = t.lastInAt ?? now();
    t.heardAt = at;
    heardLines += 1;
    // Replayed with the times the pieces actually arrived; see lag.ts.
    lag?.speechStopped(null, lastVoicedInputEndMs, bridge?.clockDriftMs() ?? null, at);
    lag?.transcribed(null, at);
    events.onHeard?.(text);
    bumpIdle();
  };

  const closeTurn = (t: Turn) => {
    turn = null;
    if (t.pendingIn.trim()) emitHeard(t);
    const text = t.out.trim();
    if (!text || t.firstOutAt === null) return;
    lag?.requested(t.heardAt ?? t.firstOutAt);
    lag?.token(t.firstOutAt);
    lag?.done(t.lastOutAt ?? t.firstOutAt);
    spend = addGeminiTurn(spend);
    publishSpend();
    events.onTranslationDone?.(text);
    bumpIdle();
  };

  const openTurn = (): Turn => {
    if (turn) return turn;
    turnsStarted += 1;
    turn = {
      pendingIn: "",
      out: "",
      firstInAt: null,
      lastInAt: null,
      firstOutAt: null,
      lastOutAt: null,
      heardAt: null
    };
    return turn;
  };

  const tickTurn = () => {
    const t = turn;
    if (!t || stopped) return;
    const at = now();
    const inQuiet = t.lastInAt === null || at - t.lastInAt >= INPUT_QUIET_MS;
    if (t.pendingIn && inQuiet) emitHeard(t);
    const outQuiet = t.lastOutAt !== null && at - t.lastOutAt >= OUTPUT_QUIET_MS;
    if (inQuiet && outQuiet) {
      closeTurn(t);
      return;
    }
    // Heard, never translated: the partner spoke the listener's own language
    // (echoTargetLanguage is off, so Gemini stays silent), or said nothing
    // translatable. Close it so the next caption does not inherit it.
    if (t.firstOutAt === null && t.lastInAt !== null && at - t.lastInAt >= UNTRANSLATED_TURN_MS) {
      closeTurn(t);
    }
  };

  const onInputText = (text: string) => {
    if (!hearing) {
      hearing = true;
      events.onHearing?.(true);
    }
    const t = openTurn();
    const at = now();
    // Speech resumed after the heard line went up: a second line in the
    // same caption, which CallShell joins with " · ".
    t.pendingIn += text;
    t.firstInAt ??= at;
    t.lastInAt = at;
  };

  const onOutputText = (text: string) => {
    const t = openTurn();
    const at = now();
    t.out += text;
    t.firstOutAt ??= at;
    t.lastOutAt = at;
    events.onTranslationDelta?.(text);
  };

  // ── Audio ────────────────────────────────────────────────────────────────

  const sendChunk = (pcm: Int16Array) => {
    chunksProduced += 1;
    const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0) / 0x8000;
    if (peak > maxInputPeak) maxInputPeak = peak;
    // The session audio clock, where this chunk ends — the `speech end` a
    // [taos-call-lag] line is measured from (OpenAI's audio_end_ms).
    if (peak >= VOICED_PEAK) lastVoicedInputEndMs = chunksProduced * 100;
    // The new socket once it is ready; until then, the one it is replacing.
    const socket = ws && socketReady ? ws : draining;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
      chunksDropped += 1;
      return;
    }
    try {
      socket.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: bytesToBase64(s16ToLeBytes(pcm)),
              mimeType: `audio/pcm;rate=${PCM_IN_RATE}`
            }
          }
        })
      );
      chunksSent += 1;
    } catch {
      chunksDropped += 1;
    }
  };

  const onOutputAudio = (b64: string) => {
    const samples = s16leBytesToFloat(base64ToBytes(b64));
    player?.push(samples, peakOfFloat(samples) >= VOICED_PEAK);
  };

  const readStats = () => {
    if (stopped) return;
    const p = player?.stats();
    const level = bridge?.level() ?? null;
    events.onDiagnostic?.(
      `interp gemini in level=${level === null ? "?" : level.toFixed(3)}` +
        ` sent=${chunksSent} dropped_in=${chunksDropped} turns=${turnsStarted}` +
        (p
          ? ` out ahead=${Math.round(p.aheadMs)}ms played=${p.played}` +
            ` drop_silence=${p.droppedSilence} drop_overrun=${p.droppedOverrun}` +
            ` underruns=${p.underruns}`
          : "")
    );
    if (
      silenceReported ||
      connectedAt === null ||
      hearing ||
      now() - connectedAt < SILENT_INPUT_AFTER_MS
    ) {
      return;
    }
    if (maxInputPeak < SILENT_PEAK) {
      silenceReported = true;
      events.onInputSilent?.();
    }
  };

  // ── The socket ───────────────────────────────────────────────────────────

  const mint = async (): Promise<string> => {
    const res = await fetch("/api/call/gemini", {
      method: "POST",
      headers: await jsonAuthHeaders(),
      body: JSON.stringify({ source: direction.source, target: direction.target })
    });
    const body = (await res.json().catch(() => ({}))) as MintResponse;
    if (!res.ok || !body.wsUrl) {
      throw new Error(body.details || body.error || "Could not start the Gemini interpreter.");
    }
    model = body.model ?? model;
    return body.wsUrl;
  };

  const onFirstConnect = () => {
    if (connectedAt !== null) return;
    connectedAt = now();
    setState("connected");
    events.onDiagnostic?.(`interp gemini connected model=${model}`);
    // The audio clock and the lag session start together, exactly as the
    // OpenAI engine starts its lag session at "connected".
    lag?.opened();
    bridge = bridgeInterpreterPcm(config.inputTrack, sendChunk);
    if (!bridge) {
      fail("This browser has no WebAudio, which the Gemini interpreter needs.");
      return;
    }
    capTimer = window.setTimeout(() => {
      events.onAutoEnd?.("max_duration");
      void stop("max_duration");
    }, maxMs);
    statsTimer = window.setInterval(readStats, STATS_MS);
    turnTimer = window.setInterval(tickTurn, TURN_TICK_MS);
    readStats();
    bumpIdle();
  };

  const openSocket = async (why: string) => {
    const url = await mint();
    if (stopped) return;
    if (connectedAt === null) setState("connecting");
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    ws = socket;
    if (connectTimer !== null) window.clearTimeout(connectTimer);
    connectTimer = window.setTimeout(() => {
      if (stopped || socketReady || ws !== socket) return;
      fail("The Gemini interpreter could not connect (no setup reply in 15s).");
    }, CONNECT_TIMEOUT_MS);

    // Everything — model, language, instruction — is inside the token.
    socket.onopen = () => socket.send(JSON.stringify({ setup: {} }));
    socket.onerror = () => events.onDiagnostic?.("interp gemini socket error");
    socket.onclose = (ev) => {
      if (stopped) return;
      if (draining === socket) {
        draining = null;
        return;
      }
      if (ws !== socket) return;
      events.onDiagnostic?.(`interp gemini closed code=${ev.code} ${ev.reason.slice(0, 120)}`);
      void restart(`closed ${ev.code}`);
    };
    socket.onmessage = (ev) => {
      const primary = ws === socket;
      if (!primary && draining !== socket) return;
      let msg: Record<string, unknown>;
      try {
        const raw =
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.setupComplete) {
        if (!primary) return;
        socketReady = true;
        if (connectTimer !== null) window.clearTimeout(connectTimer);
        connectTimer = null;
        if (connectedAt === null) onFirstConnect();
        else events.onDiagnostic?.(`interp gemini resumed after ${why}`);
        const retired = draining;
        if (retired) {
          if (drainTimer !== null) window.clearTimeout(drainTimer);
          drainTimer = window.setTimeout(() => {
            drainTimer = null;
            if (draining !== retired) return;
            draining = null;
            detach(retired);
          }, DRAIN_MS);
        }
        return;
      }
      if (msg.goAway) {
        if (!primary) return;
        // The server closes this connection ~50s from now. Nothing to carry
        // over — a translator keeps no conversation — so a fresh session,
        // opened before this one is let go (DRAIN_MS).
        events.onDiagnostic?.(`interp gemini goAway ${JSON.stringify(msg.goAway).slice(0, 80)}`);
        void restart("goAway", true);
        return;
      }
      const usage = msg.usageMetadata as
        | { promptTokenCount?: unknown; responseTokenCount?: unknown }
        | undefined;
      if (usage) {
        spend = addGeminiUsage(spend, usage);
        publishSpend();
      }
      const content = msg.serverContent as Record<string, unknown> | undefined;
      if (!content) return;
      const input = content.inputTranscription as { text?: unknown } | undefined;
      if (typeof input?.text === "string" && input.text) onInputText(input.text);
      const output = content.outputTranscription as { text?: unknown } | undefined;
      if (typeof output?.text === "string" && output.text) onOutputText(output.text);
      const parts = (content.modelTurn as { parts?: unknown[] } | undefined)?.parts ?? [];
      for (const part of parts) {
        const data = (part as { inlineData?: { data?: unknown } }).inlineData?.data;
        if (typeof data === "string" && data) onOutputAudio(data);
      }
    };
  };

  const restart = async (why: string, handover = false) => {
    if (stopped) return;
    const at = Date.now();
    restarts = restarts.filter((t) => at - t < 60_000);
    restarts.push(at);
    if (restarts.length > MAX_RESTARTS_PER_MINUTE) {
      fail(`The Gemini interpreter kept dropping (${why}).`);
      return;
    }
    if (handover && ws && socketReady) {
      // Keep the old one: it still hears the partner, and finishes speaking.
      detach(draining);
      draining = ws;
      ws = null;
      socketReady = false;
    } else {
      closeSocket();
      // The turn in flight belongs to the old session; give it its caption.
      if (turn) closeTurn(turn);
    }
    events.onDiagnostic?.(`interp gemini restarting (${why})`);
    try {
      await openSocket(why);
    } catch (error) {
      fail(error instanceof Error ? error.message : "The Gemini interpreter could not restart.");
    }
  };

  const setMuted = (next: boolean) => {
    if (muted === next) return;
    muted = next;
    // Muting stops the PLAYING, not the session: Gemini's output is one
    // stream and is billed whether anyone hears it or not.
    player?.setMuted(next);
  };

  /**
   * The target language is locked into the session's token, so a new target
   * is a new session. A new SOURCE changes nothing — Gemini detects it.
   */
  const setDirection = (next: CallDirection) => {
    const retarget = next.target !== direction.target;
    direction = next;
    if (retarget && connectedAt !== null && !stopped) void restart("language");
  };

  try {
    setState("minting");
    const ctx = ensureCallAudioContext();
    if (!ctx) throw new Error("This browser has no WebAudio, which the Gemini interpreter needs.");
    player = createPcmPlayer(ctx, PCM_OUT_RATE, (speaking) => events.onSpeaking?.(speaking));
    player.setMuted(muted);
    await openSocket("start");
    return {
      stop: () => stop("hangup"),
      setMuted,
      setDirection,
      spend: () => spend,
      inputStats
    };
  } catch (error) {
    fail(error instanceof Error ? error.message : "Failed to start the Gemini interpreter.");
    throw error;
  }
}
