"use client";

// The walkie's sounds — three short tones from a Web Audio oscillator and
// nothing else. No sound files, from anywhere (Tom, 2026-11-01): a file is a
// download, a license and a cache miss on a phone with one bar; an
// oscillator is twelve lines and always there.
//
//   keyDown  — a short beep when the button goes down: "you are on"
//   roger    — the two-note rising chirp after an incoming turn finishes
//              playing: "heard, over"
//   busy     — a low double-blip when a press is refused because the channel
//              is busy
//
// iOS keeps an AudioContext suspended until a user gesture resumes it, and
// does so SILENTLY (memory: webkit-audiocontext-gesture). So the context is
// created and resumed inside the "go on air" tap, and every tone checks the
// state before it plays rather than assuming.

export interface WalkieChirps {
  /** Call inside a user gesture. Creates/resumes the context. */
  unlock: () => Promise<boolean>;
  keyDown: () => void;
  roger: () => void;
  busy: () => void;
  close: () => void;
}

type ToneSpec = { freq: number; at: number; dur: number; gain?: number; type?: OscillatorType };

export function createWalkieChirps(): WalkieChirps {
  let ctx: AudioContext | null = null;

  const context = (): AudioContext | null => {
    if (ctx) return ctx;
    if (typeof window === "undefined") return null;
    const Ctor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      ctx = null;
    }
    return ctx;
  };

  const play = (tones: ToneSpec[]): void => {
    const c = context();
    if (!c || c.state !== "running") return;
    const t0 = c.currentTime;
    for (const tone of tones) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = tone.type ?? "sine";
      osc.frequency.value = tone.freq;
      const start = t0 + tone.at;
      const peak = tone.gain ?? 0.12;
      // A 5ms attack and release keeps the tone from clicking.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.005);
      gain.gain.setValueAtTime(peak, start + tone.dur - 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(start);
      osc.stop(start + tone.dur + 0.01);
    }
  };

  return {
    unlock: async () => {
      const c = context();
      if (!c) return false;
      try {
        if (c.state !== "running") await c.resume();
      } catch {
        /* a refused resume reads as not running below */
      }
      return c.state === "running";
    },
    keyDown: () => play([{ freq: 880, at: 0, dur: 0.07 }]),
    roger: () =>
      play([
        { freq: 1200, at: 0, dur: 0.08 },
        { freq: 1600, at: 0.09, dur: 0.1 }
      ]),
    busy: () =>
      play([
        { freq: 330, at: 0, dur: 0.08, type: "square", gain: 0.05 },
        { freq: 330, at: 0.12, dur: 0.08, type: "square", gain: 0.05 }
      ]),
    close: () => {
      const c = ctx;
      ctx = null;
      if (c) void c.close().catch(() => undefined);
    }
  };
}
