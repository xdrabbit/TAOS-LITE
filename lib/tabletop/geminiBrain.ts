"use client";

import { jsonAuthHeaders } from "@/lib/authClient";
import type { TabletopDirection } from "./instructions";
import type { TabletopLiveState, TurnResult } from "./live";
import type { ActiveTabletopBrain, TabletopBrainEvents } from "./brain";
import { createSegmentClock, geminiUsd } from "./metrics";
import { ensureTabletopAudioContext, tapMicPcm, type MicPcmTap } from "./audio";
import { bytesToBase64, PCM_IN_RATE, peakOfS16, s16ToLeBytes, VOICED_PEAK } from "./pcm";
import { GEMINI_NOT_CONFIGURED } from "./geminiSession";

// The Gemini arm of the /tabletop brain A/B (Tom, 2026-10-21). Re-aimed from
// the /call engine on spike/gemini-live-translate @ a2faa41
// (lib/call/interpreterGemini.ts). What it keeps, and what it had to change:
//
// ── Kept ───────────────────────────────────────────────────────────────────
// The one-use ephemeral token with the whole setup locked inside (minted by
// POST /api/tabletop/gemini), the Constrained WebSocket, 100 ms / 16 kHz PCM
// in, drop-never-queue backpressure, and turns marked by the TRANSCRIPT going
// quiet — Live Translate streams and has no VAD, no response, no "done".
//
// ── Changed ────────────────────────────────────────────────────────────────
// Text, not audio, is the product. The model can only answer in AUDIO
// (lib/tabletop/geminiSession.ts), so this reads `outputTranscription` as the
// translation and throws the audio frames away unplayed. The table speaks the
// turn through /api/tts at turn end, same as the OpenAI arm.
//
// ONE SOCKET PER TURN, not one per session. Two reasons, both forced:
//   1. The target language is locked into the token, and at a table the
//      target flips every time the phone changes hands.
//   2. Gemini bills the STREAM (the spike: silence in still billed 25 tok/s
//      each way). OpenAI's table mutes its track between turns; the only way
//      to stop Gemini billing between turns is to not have a socket.
// So every turn pays a mint + socket handshake. The speaker never waits on it:
// mic audio from the tap is queued and flushed the moment setupComplete
// arrives. The first turn's socket is opened by start(), which is where the
// table shows "connecting" today.
//
// No make-before-break: a turn is capped at 120 s and Gemini's goAway lands at
// ~9 min, so a turn never meets one. A socket that DOES drop mid-turn is
// reopened (that is `reconnects` on the [taos-tabletop] line).

/**
 * Output transcript quiet this long = the segment is finished. The spike's
 * OUTPUT_QUIET_MS, kept: translated speech trails the speaker by ~1.5–2.5 s
 * and its transcript arrives in step with it, in bursts well under this.
 * The segment's DONE time is its last text, not this timer.
 */
export const OUTPUT_QUIET_MS = 1200;
/** Nothing came back this long after the turn ended: nothing will. */
const UNTRANSLATED_AFTER_END_MS = 4000;
/** Same ceiling the OpenAI arm puts on draining a turn. */
const ENDTURN_DRAIN_TIMEOUT_MS = 8000;
const TICK_MS = 100;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_SOCKET_BUFFER_BYTES = 64 * 1024;
/** 15 s of audio waiting on a socket handshake is already a broken turn. */
const MAX_QUEUED_CHUNKS = 150;
const MAX_RECONNECTS_PER_TURN = 2;
/** Same as lib/tabletop/live.ts, for the same reasons. */
const IDLE_DISCONNECT_MS = 5 * 60 * 1000;
const MAX_SESSION_MS = 2 * 60 * 60 * 1000;

interface MintResponse {
  wsUrl?: string;
  model?: string;
  error?: string;
  details?: string;
}

/**
 * One turn's bookkeeping, separate from the socket so the tests can drive it
 * with recorded server messages and a fake clock.
 */
export function createGeminiTurnCore(events: Pick<TabletopBrainEvents, "onHeard" | "onPartial" | "onSegmentDone">) {
  const clock = createSegmentClock();
  let heard = "";
  const parts: string[] = [];
  let seg: { text: string; firstAt: number; lastAt: number } | null = null;
  let streamedAny = false;
  let lastOutAt: number | null = null;
  let lastInAt: number | null = null;
  let lastVoicedAt: number | null = null;
  let promptTokens = 0;
  let responseTokens = 0;

  const closeSegment = () => {
    const s = seg;
    seg = null;
    if (!s) return;
    const text = s.text.trim();
    if (!text) return;
    parts.push(text);
    events.onSegmentDone?.(text, clock.claim(s.firstAt, s.lastAt));
  };

  return {
    chunk(at: number, voiced: boolean): void {
      if (voiced) lastVoicedAt = at;
      clock.chunk(at, voiced);
    },
    /** The speaker's turn is over; a voiced run still open ends here. */
    endSpeech(): void {
      clock.flush();
    },
    /** One parsed server message. Returns what the socket layer needs. */
    message(msg: Record<string, unknown>, at: number): { setupComplete?: boolean; usageChanged?: boolean } {
      if (msg.setupComplete) return { setupComplete: true };
      let usageChanged = false;
      const usage = msg.usageMetadata as { promptTokenCount?: unknown; responseTokenCount?: unknown } | undefined;
      if (usage) {
        // Each usageMetadata is a DELTA (measured on the spike), so sum.
        if (typeof usage.promptTokenCount === "number" && usage.promptTokenCount > 0) {
          promptTokens += usage.promptTokenCount;
        }
        if (typeof usage.responseTokenCount === "number" && usage.responseTokenCount > 0) {
          responseTokens += usage.responseTokenCount;
        }
        usageChanged = true;
      }
      const content = msg.serverContent as Record<string, unknown> | undefined;
      if (content) {
        const input = content.inputTranscription as { text?: unknown } | undefined;
        if (typeof input?.text === "string" && input.text) {
          heard += input.text;
          lastInAt = at;
          if (/[\p{L}\p{N}]{2,}/u.test(heard)) events.onHeard?.(heard.trim());
        }
        const output = content.outputTranscription as { text?: unknown } | undefined;
        if (typeof output?.text === "string" && output.text) {
          if (!seg) {
            seg = { text: "", firstAt: at, lastAt: at };
            // Same separator the OpenAI arm puts between phrase responses.
            if (streamedAny) events.onPartial?.(" ");
          }
          seg.text += output.text;
          seg.lastAt = at;
          lastOutAt = at;
          streamedAny = true;
          events.onPartial?.(output.text);
        }
        // modelTurn.parts[].inlineData is the translated AUDIO. Not played,
        // not decoded — the voice is /api/tts's job. It is still billed.
      }
      return usageChanged ? { usageChanged } : {};
    },
    tick(at: number): void {
      if (seg && at - seg.lastAt >= OUTPUT_QUIET_MS) closeSegment();
    },
    /**
     * After the turn ended at `endAt`: has everything that is coming, come?
     * Output must have arrived since the speaker's last voiced chunk and then
     * gone quiet — or nothing at all for UNTRANSLATED_AFTER_END_MS.
     */
    drained(at: number, endAt: number): boolean {
      const lastActivity = Math.max(lastOutAt ?? -Infinity, lastInAt ?? -Infinity);
      const quiet = !Number.isFinite(lastActivity) || at - lastActivity >= OUTPUT_QUIET_MS;
      const answered = lastOutAt !== null && (lastVoicedAt === null || lastOutAt >= lastVoicedAt);
      if (answered && quiet) {
        closeSegment();
        return true;
      }
      return at - endAt >= UNTRANSLATED_AFTER_END_MS && quiet && lastOutAt === null;
    },
    finish(): TurnResult {
      closeSegment();
      return { heard: heard.trim(), translation: parts.join(" ") };
    },
    usd: (): number => geminiUsd(promptTokens, responseTokens),
    tokens: () => ({ promptTokens, responseTokens })
  };
}

export async function startGeminiBrain(
  events: TabletopBrainEvents,
  openingDirection: TabletopDirection
): Promise<ActiveTabletopBrain> {
  let stopped = false;
  let micStream: MediaStream | null = null;
  let tap: MicPcmTap | null = null;
  let idleTimer: number | null = null;
  let capTimer: number | null = null;
  let capReached = false;
  const startMs = Date.now();

  // The socket for the turn in progress (or, before the first turn, the warm
  // one start() opened), and its target.
  let ws: WebSocket | null = null;
  let wsTarget: string | null = null;
  let wsReady = false;
  let queue: string[] = [];

  let turnOpen = false;
  let feeding = false;
  let muted = true;
  let core: ReturnType<typeof createGeminiTurnCore> | null = null;
  let turnDirection: TabletopDirection = openingDirection;
  let reconnectsThisTurn = 0;
  // Spend from turns already closed; the open turn's lives on its core.
  let closedUsd = 0;
  let tickTimer: number | null = null;

  const setState = (s: TabletopLiveState) => events.onState?.(s);
  const now = () => performance.now();
  const totalUsd = () => closedUsd + (core?.usd() ?? 0);

  const clearIdle = () => {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    idleTimer = null;
  };

  const closeSocket = () => {
    const s = ws;
    ws = null;
    wsTarget = null;
    wsReady = false;
    queue = [];
    if (!s) return;
    s.onopen = null;
    s.onmessage = null;
    s.onclose = null;
    s.onerror = null;
    try {
      s.close();
    } catch {
      /* ignore */
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearIdle();
    if (capTimer !== null) window.clearTimeout(capTimer);
    if (tickTimer !== null) window.clearInterval(tickTimer);
    capTimer = null;
    tickTimer = null;
    closeSocket();
    tap?.release();
    tap = null;
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    setState("idle");
  };

  const bumpIdle = () => {
    if (stopped) return;
    clearIdle();
    idleTimer = window.setTimeout(() => {
      if (!turnOpen) stop();
    }, IDLE_DISCONNECT_MS);
    if (capTimer === null && !capReached) {
      capTimer = window.setTimeout(
        () => {
          capReached = true;
          if (!turnOpen) stop();
        },
        Math.max(0, MAX_SESSION_MS - (Date.now() - startMs))
      );
    }
  };

  const sendNow = (socket: WebSocket, payload: string) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    // Drop, never queue, once the link is behind: late audio is worse than
    // missing audio for something translating as you talk.
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) return;
    try {
      socket.send(payload);
    } catch {
      /* dropped */
    }
  };

  const onChunk = (pcm: Int16Array) => {
    if (stopped || !feeding) return;
    const at = now();
    // Muted = the turn is over but the socket is still finishing: send
    // silence, as the OpenAI arm's disabled track does, so nobody else's
    // voice at the table lands in this speaker's turn.
    const samples = muted ? new Int16Array(pcm.length) : pcm;
    if (!muted) core?.chunk(at, peakOfS16(pcm) >= VOICED_PEAK);
    const payload = JSON.stringify({
      realtimeInput: {
        audio: { data: bytesToBase64(s16ToLeBytes(samples)), mimeType: `audio/pcm;rate=${PCM_IN_RATE}` }
      }
    });
    if (ws && wsReady) sendNow(ws, payload);
    else if (ws && queue.length < MAX_QUEUED_CHUNKS) queue.push(payload);
  };

  const mint = async (direction: TabletopDirection): Promise<string> => {
    const res = await fetch("/api/tabletop/gemini", {
      method: "POST",
      headers: await jsonAuthHeaders(),
      body: JSON.stringify(direction)
    });
    const body = (await res.json().catch(() => ({}))) as MintResponse;
    if (!res.ok || !body.wsUrl) {
      // Fail CLOSED and say so. Never fall back to OpenAI: a Gemini session
      // that quietly ran on gpt-realtime would poison the comparison.
      throw new Error(body.error || body.details || GEMINI_NOT_CONFIGURED);
    }
    return body.wsUrl;
  };

  /** Open a socket for `direction` and resolve on setupComplete. */
  const openSocket = (direction: TabletopDirection): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      closeSocket();
      const target = direction.target;
      wsTarget = target;
      void mint(direction)
        .then((url) => {
          if (stopped || wsTarget !== target) {
            reject(new Error("superseded"));
            return;
          }
          const socket = new WebSocket(url);
          socket.binaryType = "arraybuffer";
          ws = socket;
          const timeout = window.setTimeout(() => {
            if (ws === socket && !wsReady) reject(new Error("Gemini did not answer in 15s."));
          }, CONNECT_TIMEOUT_MS);
          // Everything — model, language, instruction — is inside the token.
          socket.onopen = () => socket.send(JSON.stringify({ setup: {} }));
          socket.onmessage = (ev) => {
            if (ws !== socket) return;
            let msg: Record<string, unknown>;
            try {
              const raw =
                typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
              msg = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              return;
            }
            if (msg.setupComplete) {
              window.clearTimeout(timeout);
              wsReady = true;
              const pending = queue;
              queue = [];
              for (const p of pending) sendNow(socket, p);
              resolve();
              return;
            }
            const r = core?.message(msg, now());
            if (r?.usageChanged) events.onSpend?.(totalUsd());
          };
          socket.onerror = () => {
            /* onclose follows and decides */
          };
          socket.onclose = (ev) => {
            if (ws !== socket) return;
            window.clearTimeout(timeout);
            const wasReady = wsReady;
            ws = null;
            wsReady = false;
            if (!wasReady) {
              reject(new Error(`Gemini closed the connection (${ev.code}) ${ev.reason.slice(0, 120)}`.trim()));
              return;
            }
            // Mid-turn and not by us: reopen and carry on.
            if (feeding && !stopped && reconnectsThisTurn < MAX_RECONNECTS_PER_TURN) {
              reconnectsThisTurn += 1;
              events.onReconnect?.();
              void openSocket(turnDirection).catch((e: unknown) =>
                events.onError?.(e instanceof Error ? e.message : "Gemini reconnect failed.")
              );
            }
          };
        })
        .catch(reject);
    });

  try {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      !window.isSecureContext
    ) {
      throw new Error("Microphone is unavailable here. Open the app over HTTPS and allow mic access.");
    }
    setState("requesting_mic");
    // The same constraints as the OpenAI arm: same mic, same noise handling.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { autoGainControl: true, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
    const track = micStream.getAudioTracks()[0] ?? null;
    if (!track) throw new Error("No microphone track.");
    if (!ensureTabletopAudioContext()) throw new Error("This browser has no WebAudio, which the Gemini brain needs.");
    tap = tapMicPcm(track, onChunk);
    if (!tap) throw new Error("This browser has no WebAudio, which the Gemini brain needs.");

    setState("minting");
    // The first turn's socket, opened now so the first tap's "connecting" is
    // where the handshake shows — as it is for OpenAI.
    setState("connecting");
    await openSocket(openingDirection);
    setState("ready");
    bumpIdle();
    tickTimer = window.setInterval(() => {
      if (core) core.tick(now());
    }, TICK_MS);

    const beginTurn = (direction: TabletopDirection): boolean => {
      if (stopped || !tap) {
        events.onError?.("Not connected yet — tap again in a second.");
        return false;
      }
      ensureTabletopAudioContext();
      clearIdle();
      turnOpen = true;
      turnDirection = direction;
      reconnectsThisTurn = 0;
      core = createGeminiTurnCore(events);
      muted = false;
      feeding = true;
      // The warm socket is good only for its own target; anything else is a
      // new token. Audio from now on queues until the new one is ready.
      if (!(ws && wsTarget === direction.target)) {
        void openSocket(direction).catch((e: unknown) => {
          if (e instanceof Error && e.message === "superseded") return;
          events.onError?.(e instanceof Error ? e.message : GEMINI_NOT_CONFIGURED);
        });
      }
      return true;
    };

    const endTurn = async (): Promise<TurnResult> => {
      turnOpen = false;
      muted = true;
      const turn = core;
      if (!turn) return { heard: "", translation: "" };
      turn.endSpeech();
      const endAt = now();
      await new Promise<void>((resolve) => {
        const check = window.setInterval(() => {
          const at = now();
          if (!ws || turn.drained(at, endAt) || at - endAt >= ENDTURN_DRAIN_TIMEOUT_MS) {
            window.clearInterval(check);
            resolve();
          }
        }, TICK_MS);
      });
      feeding = false;
      // This turn's socket has done its job; a live socket between turns is
      // a bill (see the header).
      closeSocket();
      const result = turn.finish();
      closedUsd += turn.usd();
      if (core === turn) core = null;
      events.onSpend?.(totalUsd());
      if (capReached) stop();
      else bumpIdle();
      return result;
    };

    return { kind: "gemini", beginTurn, endTurn, stop };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start the Gemini brain.";
    setState("error");
    events.onError?.(message);
    stop();
    throw error;
  }
}
