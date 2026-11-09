"use client";

// Interpreter mode in the browser: one microphone, shared by every LEG of the
// session, and each leg's voice played as it arrives (Tom, 2026-11-09).
//
//   startInterpreter()  mic → POST /api/tabletop/interpreter/session → one
//                       transport per leg → resolves once every leg is live.
//
// A leg is one provider session (lib/interpreter/plan.ts). Its transport is
// here; what its events MEAN is in lib/interpreter/legEvents.ts, which has no
// browser in it and is what the tests exercise.
//
// ── Continuous, not push-to-talk ───────────────────────────────────────────
// The mic track is live from the first tap to Stop. Nothing here opens or
// closes a turn: the provider's own turn detection decides when a thought is
// finished and answers it, and speaking over the interpreter cuts it off
// (barge-in) — that is configured on the session, server-side.
//
// ── The speaker is next to the microphone ──────────────────────────────────
// One phone, lying on the table, playing the interpretation out of the same
// device that is listening. What stops it interpreting itself is the
// browser's echo canceller (`echoCancellation: true` below), which works on
// audio the PAGE plays — so every leg plays through an <audio> element, the
// same way /tutor's voice does.
//
// ── What ends a session ────────────────────────────────────────────────────
// Stop, the cap, the idle stop (the shell's clock, lib/interpreter/limits.ts)
// or a leg failing. All of them go through stop(), which closes every leg,
// stops the mic, and returns the final tally for the cost line.

import { jsonAuthHeaders } from "@/lib/authClient";
import { ensureTabletopAudioContext, tapMicPcm, type MicPcmTap } from "@/lib/tabletop/audio";
import { bytesToBase64, PCM_IN_RATE, s16ToLeBytes } from "@/lib/tabletop/pcm";
import type { CaptionUpdate } from "./captions";
import {
  addGeminiUsage,
  addUsage,
  emptyInterpreterTally,
  type InterpreterTally
} from "./cost";
import type { InterpreterEngine } from "./engine";
import {
  createGeminiReader,
  createRealtimeReader,
  createSharedHeard,
  createStreamReader,
  type LegIdentity,
  type LegReader,
  type LegSink
} from "./legEvents";

export interface InterpreterHandlers {
  onCaption: (update: CaptionUpdate) => void;
  onActivity: () => void;
  onTally: (tally: InterpreterTally) => void;
  onError: (message: string) => void;
  /** A leg died underneath a running session. The shell stops it. */
  onLegLost: () => void;
}

export interface BriefingReceipt {
  applied: boolean;
  contextChars: number;
  contextStatus: "ok" | "missing_table" | "unavailable";
}

export interface ActiveInterpreter {
  engine: InterpreterEngine;
  model: string;
  legs: number;
  maxSeconds: number;
  idleSeconds: number;
  briefing: BriefingReceipt;
  tally: () => InterpreterTally;
  /** Close everything. Idempotent; resolves with the final tally. */
  stop: () => Promise<InterpreterTally>;
}

type LegTicket = {
  source: string | null;
  target: string | null;
  voice: string | null;
} & (
  | { transport: "openai-webrtc"; clientSecret: string; callUrl: string }
  | { transport: "openai-live-relay"; relayUrl: string; leg: number }
  | { transport: "gemini-ws"; wsUrl: string }
);

interface MintResponse {
  engine?: InterpreterEngine;
  model?: string;
  legs?: LegTicket[];
  maxSeconds?: number;
  idleSeconds?: number;
  briefing?: BriefingReceipt;
  error?: string;
  details?: string;
}

interface Leg {
  close: () => Promise<void>;
  tick: (nowMs: number) => void;
  /** Wall-clock seconds this leg has been connected. */
  connectedSeconds: () => number;
}

const CONNECT_TIMEOUT_MS = 15_000;
/** How long Stop waits for a provider's final usage before hanging up anyway. */
const CLOSE_GRACE_MS = 1200;
const TICK_MS = 250;
/** Gemini's sockets last ~10 minutes; a dinner is longer. */
const MAX_GEMINI_RECONNECTS = 6;
const GEMINI_OUT_RATE = 24_000;

function hiddenAudio(): HTMLAudioElement {
  const el = document.createElement("audio");
  el.autoplay = true;
  (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
  // Some browsers will not play a detached element; keep it in the DOM, unseen.
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

async function mintSession(engine: InterpreterEngine, mine: string, theirs: string): Promise<MintResponse> {
  const res = await fetch("/api/tabletop/interpreter/session", {
    method: "POST",
    headers: await jsonAuthHeaders(),
    body: JSON.stringify({ engine, mine, theirs })
  });
  const body = (await res.json().catch(() => ({}))) as MintResponse;
  if (!res.ok || !Array.isArray(body.legs) || body.legs.length === 0) {
    throw new Error(body.details || body.error || "Could not start the interpreter.");
  }
  return body;
}

export async function startInterpreter(opts: {
  engine: InterpreterEngine;
  mine: string;
  theirs: string;
  handlers: InterpreterHandlers;
}): Promise<ActiveInterpreter> {
  const { handlers, mine, theirs } = opts;
  let mic: MediaStream | null = null;
  let legs: Leg[] = [];
  let stopped = false;
  let ticker: number | null = null;
  let tally = emptyInterpreterTally(opts.engine, "", Date.now());
  /** Provider-reported seconds per leg (GPT-Live). */
  const billedByLeg = new Map<number, number>();

  const publish = (next: InterpreterTally) => {
    tally = next;
    if (!stopped) handlers.onTally(currentTally());
  };

  /**
   * Set by stop(): the numbers as they stood when the session ended. The cost
   * line is read AFTER the legs are torn down, and a per-minute engine's
   * seconds are computed from its legs — found by the browser check, which
   * saw `billed_secs=0` on every per-minute session.
   */
  let finalTally: InterpreterTally | null = null;

  function currentTally(): InterpreterTally {
    if (finalTally) return finalTally;
    if (tally.engine !== "openai-translate" && tally.engine !== "openai-live") return tally;
    // Per-minute engines. GPT-Live reports its own seconds; where a leg has
    // not (and for translate, which never does) the wall clock stands in —
    // both bill the session's duration, silence included.
    let seconds = 0;
    legs.forEach((leg, index) => {
      seconds += billedByLeg.get(index) ?? leg.connectedSeconds();
    });
    return { ...tally, billedSeconds: Math.max(tally.billedSeconds, seconds) };
  }

  let stopping: Promise<InterpreterTally> | null = null;
  const stop = (): Promise<InterpreterTally> => {
    stopping ??= (async () => {
      const before = currentTally();
      stopped = true;
      if (ticker !== null) window.clearInterval(ticker);
      ticker = null;
      await Promise.all(legs.map((leg) => leg.close().catch(() => {})));
      // Read again: a graceful close can deliver a leg's final seconds.
      const after = currentTally();
      finalTally = after.billedSeconds >= before.billedSeconds ? after : before;
      legs = [];
      mic?.getTracks().forEach((t) => t.stop());
      mic = null;
      return finalTally;
    })();
    return stopping;
  };

  try {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      !window.isSecureContext
    ) {
      throw new Error("Microphone is unavailable here. Open the app over HTTPS and allow mic access.");
    }
    mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        // THE thing that keeps the interpreter from interpreting itself.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });
    const micTrack = mic.getAudioTracks()[0];
    if (!micTrack) throw new Error("No microphone track.");

    const mint = await mintSession(opts.engine, mine, theirs);
    const tickets = mint.legs ?? [];
    const engine = mint.engine ?? opts.engine;
    tally = emptyInterpreterTally(engine, mint.model ?? "", Date.now(), tickets.length);

    const shared = createSharedHeard();
    // Gate a leg's speaker on WORDS only where a second leg is listening to
    // the same sentence and told to keep quiet (see LegSink.gate).
    const gated = engine === "openai-realtime" && tickets.length > 1;

    const sinkFor = (index: number, setAudible: (open: boolean) => void, flush: () => void): LegSink => ({
      caption: (update) => {
        if (!stopped) handlers.onCaption(update);
      },
      activity: () => {
        if (!stopped) handlers.onActivity();
      },
      usage: (usage) => publish(addUsage(tally, usage)),
      geminiUsage: (usage) => publish(addGeminiUsage(tally, usage)),
      transcribed: (seconds) =>
        publish({ ...tally, transcribedSeconds: tally.transcribedSeconds + Math.max(0, seconds) }),
      billed: (seconds) => {
        billedByLeg.set(index, Math.max(billedByLeg.get(index) ?? 0, seconds));
        publish(tally);
      },
      bargeIn: () => publish({ ...tally, bargeIns: tally.bargeIns + 1 }),
      gate: (open) => {
        if (gated) setAudible(open);
      },
      flushAudio: flush,
      error: (message) => {
        publish({ ...tally, errors: tally.errors + 1 });
        if (!stopped) handlers.onError(message);
      },
      closed: () => {
        if (!stopped) handlers.onLegLost();
      }
    });

    const connect = (ticket: LegTicket, index: number): Promise<Leg> => {
      const identity: LegIdentity = { index, source: ticket.source, target: ticket.target };
      if (ticket.transport === "gemini-ws") {
        return connectGeminiLeg({
          ticket,
          identity,
          micTrack,
          makeReader: (sink) => createGeminiReader(identity, sink, shared, { ownsHeard: index === 0 }),
          sinkFor: (flush) => sinkFor(index, () => {}, flush),
          remint: async () => {
            const again = await mintSession(engine, mine, theirs);
            const next = again.legs?.[index];
            if (!next || next.transport !== "gemini-ws") throw new Error("Could not reconnect.");
            return next.wsUrl;
          },
          onLost: () => {
            if (!stopped) handlers.onLegLost();
          },
          isStopped: () => stopped
        });
      }
      return connectWebRtcLeg({
        ticket,
        identity,
        micTrack,
        mine,
        theirs,
        startMuted: gated,
        makeReader: (sink) =>
          engine === "openai-realtime"
            ? createRealtimeReader(identity, sink)
            : createStreamReader(identity, sink, shared, { ownsHeard: index === 0 }),
        sinkFor: (setAudible) => sinkFor(index, setAudible, () => {}),
        graceful: engine !== "openai-realtime",
        onLost: () => {
          if (!stopped) handlers.onLegLost();
        }
      });
    };

    const settled = await Promise.allSettled(tickets.map(connect));
    legs = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) {
      throw failed.reason instanceof Error ? failed.reason : new Error("Could not connect the interpreter.");
    }

    ticker = window.setInterval(() => {
      const nowMs = Date.now();
      for (const leg of legs) leg.tick(nowMs);
    }, TICK_MS);

    return {
      engine,
      model: mint.model ?? "",
      legs: legs.length,
      maxSeconds: typeof mint.maxSeconds === "number" && mint.maxSeconds > 0 ? mint.maxSeconds : 1800,
      idleSeconds: typeof mint.idleSeconds === "number" && mint.idleSeconds > 0 ? mint.idleSeconds : 60,
      briefing: mint.briefing ?? { applied: false, contextChars: 0, contextStatus: "unavailable" },
      tally: currentTally,
      stop
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

// ── WebRTC legs: gpt-realtime-2.1, gpt-realtime-translate, gpt-live-1 ──────

async function connectWebRtcLeg(opts: {
  ticket: Extract<LegTicket, { transport: "openai-webrtc" | "openai-live-relay" }>;
  identity: LegIdentity;
  micTrack: MediaStreamTrack;
  mine: string;
  theirs: string;
  startMuted: boolean;
  makeReader: (sink: LegSink) => LegReader;
  sinkFor: (setAudible: (open: boolean) => void) => LegSink;
  /** Send `session.close` and wait for the provider's last word before hanging up. */
  graceful: boolean;
  onLost: () => void;
}): Promise<Leg> {
  const { ticket } = opts;
  const pc = new RTCPeerConnection();
  const audioEl = hiddenAudio();
  audioEl.muted = opts.startMuted;
  // Each leg gets its OWN copy of the mic track: two peer connections cannot
  // share one, and stopping a clone leaves the microphone to the others.
  const track = opts.micTrack.clone();
  const connectedAt = Date.now();
  let closed = false;
  let sawClosed: (() => void) | null = null;

  const sink = opts.sinkFor((open) => {
    audioEl.muted = !open;
  });
  const reader = opts.makeReader({
    ...sink,
    closed: () => {
      sawClosed?.();
      if (!closed) sink.closed();
    }
  });

  const teardown = () => {
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    track.stop();
    audioEl.srcObject = null;
    audioEl.remove();
  };

  try {
    pc.ontrack = (ev) => {
      audioEl.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
      void audioEl.play().catch(() => {
        /* autoplay refused: the captions still run, and Start was a tap */
      });
    };
    pc.addTrack(track, new MediaStream([track]));
    pc.onconnectionstatechange = () => {
      if (closed) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") opts.onLost();
    };

    const dc = pc.createDataChannel("oai-events");
    dc.onmessage = ({ data }) => {
      try {
        reader.handle(JSON.parse(String(data)) as Record<string, unknown>);
      } catch {
        /* a frame we cannot read is not a reason to end a dinner */
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    let answer: string;
    if (ticket.transport === "openai-webrtc") {
      const res = await fetch(ticket.callUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${ticket.clientSecret}`, "Content-Type": "application/sdp" },
        body: offer.sdp ?? ""
      });
      if (!res.ok) {
        const details = await res.text().catch(() => "");
        throw new Error(`Interpreter connection failed (${res.status}). ${details.slice(0, 200)}`);
      }
      answer = await res.text();
    } else {
      // GPT-Live: our server exchanges the offer (…/interpreter/live).
      const res = await fetch(ticket.relayUrl, {
        method: "POST",
        headers: await jsonAuthHeaders(),
        body: JSON.stringify({ sdp: offer.sdp ?? "", leg: ticket.leg, mine: opts.mine, theirs: opts.theirs })
      });
      const body = (await res.json().catch(() => ({}))) as { sdp?: string; error?: string; details?: string };
      if (!res.ok || !body.sdp) {
        throw new Error(body.details || body.error || `Interpreter connection failed (${res.status}).`);
      }
      answer = body.sdp;
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answer });

    await new Promise<void>((resolve, reject) => {
      if (dc.readyState === "open") {
        resolve();
        return;
      }
      const timeout = window.setTimeout(
        () => reject(new Error("The interpreter did not connect in time — try again.")),
        CONNECT_TIMEOUT_MS
      );
      dc.addEventListener(
        "open",
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          window.clearTimeout(timeout);
          reject(new Error("The interpreter connection failed — try again."));
        }
      });
    });

    return {
      tick: reader.tick,
      connectedSeconds: () => Math.max(0, (Date.now() - connectedAt) / 1000),
      close: async () => {
        if (closed) return;
        closed = true;
        if (opts.graceful && dc.readyState === "open") {
          // Ask, then wait briefly for `session.closed` — it carries the
          // session's final billed seconds.
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, CLOSE_GRACE_MS);
            sawClosed = () => {
              window.clearTimeout(timer);
              resolve();
            };
            try {
              dc.send(JSON.stringify({ type: "session.close" }));
            } catch {
              window.clearTimeout(timer);
              resolve();
            }
          });
        }
        teardown();
      }
    };
  } catch (error) {
    closed = true;
    teardown();
    throw error;
  }
}

// ── Gemini Live leg: a socket, PCM in, PCM out ─────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Plays 24 kHz s16 chunks back to back. Routed through an <audio> element
 * (not straight to the context's destination) so it is page audio like the
 * WebRTC legs' — which is what the echo canceller is listening for.
 */
function createPcmPlayer(): { play: (bytes: Uint8Array) => void; flush: () => void; close: () => void } | null {
  const ctx = ensureTabletopAudioContext();
  if (!ctx || typeof ctx.createMediaStreamDestination !== "function") return null;
  const out = ctx.createMediaStreamDestination();
  const el = hiddenAudio();
  el.srcObject = out.stream;
  void el.play().catch(() => {});
  let nextAt = 0;
  let sources: AudioBufferSourceNode[] = [];
  return {
    play: (bytes) => {
      const samples = Math.floor(bytes.length / 2);
      if (!samples) return;
      const buffer = ctx.createBuffer(1, samples, GEMINI_OUT_RATE);
      const channel = buffer.getChannelData(0);
      const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
      for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 0x8000;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(out);
      const at = Math.max(ctx.currentTime + 0.02, nextAt);
      source.start(at);
      nextAt = at + buffer.duration;
      sources.push(source);
      source.onended = () => {
        sources = sources.filter((s) => s !== source);
      };
    },
    flush: () => {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* already ended */
        }
      }
      sources = [];
      nextAt = 0;
    },
    close: () => {
      el.srcObject = null;
      el.remove();
      try {
        out.disconnect();
      } catch {
        /* ignore */
      }
    }
  };
}

async function connectGeminiLeg(opts: {
  ticket: Extract<LegTicket, { transport: "gemini-ws" }>;
  identity: LegIdentity;
  micTrack: MediaStreamTrack;
  makeReader: (sink: LegSink) => LegReader;
  sinkFor: (flush: () => void) => LegSink;
  /** A fresh one-use socket URL for this leg. */
  remint: () => Promise<string>;
  onLost: () => void;
  isStopped: () => boolean;
}): Promise<Leg> {
  const player = createPcmPlayer();
  if (!player) throw new Error("This browser cannot play Gemini's audio.");
  const track = opts.micTrack.clone();
  const connectedAt = Date.now();
  const reader = opts.makeReader(opts.sinkFor(() => player.flush()));
  let ws: WebSocket | null = null;
  let ready = false;
  let closed = false;
  let reconnects = 0;
  let tap: MicPcmTap | null = null;

  const open = (url: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      ws = socket;
      ready = false;
      const timeout = window.setTimeout(() => {
        if (!ready) reject(new Error("Gemini did not answer in time."));
      }, CONNECT_TIMEOUT_MS);
      // Model, voice and briefing are all inside the token.
      socket.onopen = () => socket.send(JSON.stringify({ setup: {} }));
      socket.onmessage = (ev) => {
        if (ws !== socket) return;
        let msg: Record<string, unknown>;
        try {
          const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.setupComplete) {
          window.clearTimeout(timeout);
          ready = true;
          resolve();
          return;
        }
        const content = msg.serverContent as { modelTurn?: { parts?: { inlineData?: { data?: string } }[] } } | undefined;
        for (const part of content?.modelTurn?.parts ?? []) {
          const data = part?.inlineData?.data;
          if (typeof data === "string" && data) player.play(base64ToBytes(data));
        }
        reader.handle(msg);
      };
      socket.onclose = (ev) => {
        if (ws !== socket) return;
        window.clearTimeout(timeout);
        const wasReady = ready;
        ws = null;
        ready = false;
        if (!wasReady) {
          reject(new Error(`Gemini closed the connection (${ev.code}).`));
          return;
        }
        if (closed || opts.isStopped()) return;
        // The ~10-minute socket limit (goAway), or a drop. Open a fresh one;
        // the briefing rides in the new token, so the interpreter loses only
        // its short memory of the conversation.
        if (reconnects >= MAX_GEMINI_RECONNECTS) {
          opts.onLost();
          return;
        }
        reconnects += 1;
        void opts
          .remint()
          .then((next) => open(next))
          .catch(() => opts.onLost());
      };
    });

  try {
    await open(opts.ticket.wsUrl);
    tap = tapMicPcm(track, (pcm) => {
      if (!ws || !ready || ws.readyState !== WebSocket.OPEN) return;
      // Drop, never queue: a backed-up socket must not turn into latency.
      if (ws.bufferedAmount > 64 * 1024) return;
      ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: { data: bytesToBase64(s16ToLeBytes(pcm)), mimeType: `audio/pcm;rate=${PCM_IN_RATE}` }
          }
        })
      );
    });
    if (!tap) throw new Error("This browser cannot stream the microphone to Gemini.");
    return {
      tick: reader.tick,
      connectedSeconds: () => Math.max(0, (Date.now() - connectedAt) / 1000),
      close: async () => {
        closed = true;
        tap?.release();
        tap = null;
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        ws = null;
        player.flush();
        player.close();
        track.stop();
      }
    };
  } catch (error) {
    closed = true;
    tap?.release();
    try {
      (ws as WebSocket | null)?.close();
    } catch {
      /* ignore */
    }
    player.close();
    track.stop();
    throw error;
  }
}
