"use client";

import { createPcmDownsampler, peakOfS16 } from "./pcm";

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
  } catch {
    sharedCtx = null;
    return null;
  }
  void sharedCtx.resume().catch(() => {
    /* created outside a gesture; the next ensure() will try again */
  });
  return sharedCtx;
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
  onChunk: (pcm: Int16Array) => void
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
    const downsampler = createPcmDownsampler(ctx.sampleRate, (chunk) => {
      lastPeak = peakOfS16(chunk);
      onChunk(chunk);
    });
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
