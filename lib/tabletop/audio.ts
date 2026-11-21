"use client";

import { createPcmDownsampler, PCM_IN_RATE, peakOfS16 } from "./pcm";

// The Gemini brain's microphone tap: the speaker's mic as 16 kHz mono s16
// chunks of 100 ms, which is what Live Translate takes on its WebSocket.
//
// Adapted from bridgeInterpreterPcm on spike/gemini-live-translate @ a2faa41
// (lib/call/audioBridge.ts). There it tapped the call PARTNER's received
// track; here it taps this phone's own microphone, which is the whole point
// of a table — one phone, whoever is holding the button.
//
// ── The context must be born in a tap ──────────────────────────────────────
// iOS will not start an AudioContext outside a user gesture, and it says
// nothing when it refuses: the graph sits suspended and delivers no frames
// (see the WebKit AudioContext memory). The brain is started after awaits —
// getUserMedia, the token mint — so the context is NOT created there.
// TabletopShell calls ensureTabletopAudioContext() synchronously inside the
// talk button's onClick, and the brain only ever picks up that one.
//
// The OpenAI arm never touches this file. Its mic goes to WebRTC exactly as
// it did before the A/B.

let sharedCtx: AudioContext | null = null;
/** When the shared context was made (wall clock), for the diagnostics line. */
let sharedBornAt = 0;

function contextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

/** Create-or-resume. Call from inside a tap; idempotent after that. */
export function ensureTabletopAudioContext(): AudioContext | null {
  if (sharedCtx && sharedCtx.state !== "closed") {
    if (sharedCtx.state === "suspended") {
      void sharedCtx.resume().catch(() => {
        /* resumes on the next gesture */
      });
    }
    return sharedCtx;
  }
  const Ctor = contextCtor();
  if (!Ctor) return null;
  try {
    sharedCtx = new Ctor();
    sharedBornAt = Date.now();
  } catch {
    sharedCtx = null;
    return null;
  }
  void sharedCtx.resume().catch(() => {
    /* created outside a gesture; the next ensure() will try again */
  });
  return sharedCtx;
}

// ── A context is only as good as the audio session it was born into ────────
// The shared context above is made once, in the first tap of the page, and
// then lives for as long as the tab does. On a phone that is a long time and
// a lot of weather: the microphone opens and closes, a WebRTC engine takes
// the audio session into voice-processing mode and gives it back, the route
// moves between the speaker and the earpiece. iOS re-rates the HARDWARE each
// time and does not re-rate a context that already exists — and a context
// whose rate no longer matches the hardware under it does not fail, it
// renders: each hardware buffer gets part of a block and the rest of an old
// one. That is heard as a fragment repeating very fast.
//
// Tom and Liz's table, 2026-11-09 afternoon, is that sequence exactly: an
// A/B of six engines on one page — the WebRTC ones first, then Grok and
// ElevenLabs through a context born before any of it — and "a folding
// waveform that repeats at a rapid rate" on those two only, with every
// provider event in order. The morning's Grok session, on a fresh page, was
// clean. This is INFERRED: no desktop engine re-rates its hardware, so no
// desktop browser reproduces it. What says so is the phone — `ctx_rate`
// against `ctx_rate_was` on the next [taos-interpreter-diag] line.
//
// So a socket session gets a context made AFTER its microphone is live — the
// audio session it will actually play into — and the old one is closed. A
// page that is capturing may start a context without a tap (WebKit and
// Chromium both); if this browser will not, the new one is thrown away and
// the old one is kept, so the worst case is what shipped before.

export interface ContextRenewal {
  /** A fresh context is now the shared one. */
  renewed: boolean;
  /** The shared context's rate now, and the rate of the one it replaced (0 = there was none). */
  rate: number;
  rateWas: number;
  /** How old the replaced (or kept) context was, in seconds. */
  ageS: number;
}

/** How long a fresh context gets to start running before it is given up on. */
export const CONTEXT_RENEW_WAIT_MS = 500;

export async function renewTabletopAudioContext(
  waitMs: number = CONTEXT_RENEW_WAIT_MS
): Promise<ContextRenewal | null> {
  const Ctor = contextCtor();
  if (!Ctor) return null;
  const old = sharedCtx && sharedCtx.state !== "closed" ? sharedCtx : null;
  const ageS = old && sharedBornAt ? Math.max(0, Math.round((Date.now() - sharedBornAt) / 1000)) : 0;
  const rateWas = old?.sampleRate ?? 0;
  let fresh: AudioContext;
  try {
    fresh = new Ctor();
  } catch {
    return old ? { renewed: false, rate: old.sampleRate, rateWas, ageS } : null;
  }
  const bornAt = Date.now();
  await Promise.race([
    fresh.resume().catch(() => {
      /* not allowed to start here: decided by its state, below */
    }),
    new Promise<void>((resolve) => setTimeout(resolve, waitMs))
  ]);
  if (fresh.state !== "running" && old) {
    // It would not start outside a tap. Keep the one that was born in one.
    void fresh.close().catch(() => {});
    return { renewed: false, rate: old.sampleRate, rateWas, ageS };
  }
  sharedCtx = fresh;
  sharedBornAt = bornAt;
  if (old) void old.close().catch(() => {});
  return { renewed: true, rate: fresh.sampleRate, rateWas, ageS };
}

export interface MicPcmTap {
  /** Peak of the most recent chunk, 0..1. */
  level: () => number;
  /** Drop the nodes. The mic track itself belongs to the caller. */
  release: () => void;
}

/** Frames per processor callback: ~43 ms at 48 kHz. */
const PCM_TAP_FRAMES = 2048;

/**
 * Tap a mic track as 16 kHz s16 chunks of 100 ms. Null where there is no
 * WebAudio — and then there is no Gemini brain, because a WebSocket has no
 * raw-track fallback.
 */
export function tapMicPcm(
  track: MediaStreamTrack,
  onChunk: (pcm: Int16Array) => void,
  /**
   * Output rate. 16 kHz is Gemini's and the default; Interpreter mode's
   * socket engines (Grok, ElevenLabs Realtime) are sent 24 kHz, the only rate
   * ElevenLabs accepts. Chunks stay 100 ms long at any rate.
   */
  rate: number = PCM_IN_RATE
): MicPcmTap | null {
  const ctx = ensureTabletopAudioContext();
  if (
    !ctx ||
    typeof ctx.createMediaStreamSource !== "function" ||
    typeof ctx.createScriptProcessor !== "function"
  ) {
    return null;
  }
  try {
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const tap = ctx.createScriptProcessor(PCM_TAP_FRAMES, 1, 1);
    // A processor only runs while connected to the destination — through a
    // gain of zero, because nobody at the table wants to hear themselves.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    let lastPeak = 0;
    const downsampler = createPcmDownsampler(
      ctx.sampleRate,
      (chunk) => {
        lastPeak = peakOfS16(chunk);
        onChunk(chunk);
      },
      rate,
      Math.round(rate / 10)
    );
    tap.onaudioprocess = (ev) => downsampler.push(ev.inputBuffer.getChannelData(0));
    source.connect(tap);
    tap.connect(sink);
    sink.connect(ctx.destination);
    return {
      level: () => lastPeak,
      release: () => {
        tap.onaudioprocess = null;
        for (const node of [source, tap, sink]) {
          try {
            node.disconnect();
          } catch {
            /* ignore */
          }
        }
      }
    };
  } catch {
    return null;
  }
}
