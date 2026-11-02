// The home screen's recorder, in pieces a second screen can hold.
//
// The push-to-talk mic on "/" is the one microphone in TAOS that works on an
// iPhone: a plain MediaRecorder, a voice-friendly bitrate, a flush every
// second, and the two handlers that keep an iOS audio-session interruption
// from eating the turn. /fast built its own streaming mic and lost a week to
// WebKit (lib/release.ts, fastMicEnabled). So when Taokie needed a
// hold-to-talk button (2026-11-01), the decision was "reuse the home
// recorder, don't build a mic" — and the parts of it that are not tied to the
// home screen's state moved here so both can import them. TranslatorShell's
// behaviour is unchanged; it reads the same constants from this file now.
//
// Nothing here touches React or the DOM beyond MediaRecorder.isTypeSupported.

// A stop within this window is an accidental rapid double-tap, not a turn.
// Sub-second clips carry no usable speech, and the really short ones don't
// even have complete container headers — OpenAI rejects those as "corrupted
// or unsupported". Catch them before they leave the phone.
export const MIN_TURN_DURATION_MS = 600;

// Keep the upload well under Vercel's ~4.5 MB request-body limit even on a
// full-length turn: cap MediaRecorder at a voice-friendly bitrate
// (32 kbps ≈ 1.2 MB for 5 min) so the audio buffer can't grow unbounded.
export const AUDIO_BITS_PER_SECOND = 32000;

export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

export function fileNameFor(mime: string): string {
  if (mime.includes("webm")) return "audio.webm";
  if (mime.includes("mp4") || mime.includes("aac")) return "audio.mp4";
  return "audio.webm";
}

// ── The "wrap up" ramp ─────────────────────────────────────────────────────
// Visual only. NO audio cues on the home screen — the mic and speaker are
// both live during a turn, so the only safe signal there is visual.
//
// T-30s → T-10s: a gentle slow breathing glow (early heads-up).
// T-10s → T-0:  a pulse that accelerates as the period shrinks 600ms → 150ms.
export const RAMP_EARLY_MS = 30000; // T-30s remaining: gentle "breathing" glow begins
export const RAMP_FAST_MS = 10000; // T-10s remaining: pulse starts accelerating
export const PULSE_SLOW_MS = 600; // pulse period at the start of the fast ramp (T-10s)
export const PULSE_FAST_MS = 150; // pulse period as it reaches T-0 (fastest)
const BREATHE_PERIOD_MS = 2400;

export interface RampWindows {
  early: number;
  fast: number;
}

/**
 * Where the two ramp windows sit for a given cap.
 *
 * The home screen's five-minute turn gets the 30s/10s it has always had. A
 * cap shorter than three times the early window (Taokie's 30s) scales both
 * down proportionally — a third and a ninth of the cap — so the glow still
 * means "wrap up", not "you just started".
 */
export function rampWindows(capMs: number): RampWindows {
  if (capMs >= RAMP_EARLY_MS * 3) return { early: RAMP_EARLY_MS, fast: RAMP_FAST_MS };
  return { early: Math.round(capMs / 3), fast: Math.round(capMs / 9) };
}

/** The pulse period at this point in the ramp, in ms. */
export function pulsePeriod(remainingMs: number, windows: RampWindows): number {
  const urgent = remainingMs <= windows.fast;
  return urgent
    ? PULSE_FAST_MS + (PULSE_SLOW_MS - PULSE_FAST_MS) * (Math.max(0, remainingMs) / windows.fast)
    : BREATHE_PERIOD_MS;
}

export interface RampStyle {
  transform: string;
  boxShadow: string;
}

/**
 * The button's inline style for one frame. `wave` is 0..1 — the caller
 * advances a sine phase by dt/period and hands in (sin+1)/2, or a steady
 * value when the person asked for reduced motion.
 */
export function rampStyle(
  remainingMs: number,
  wave: number,
  windows: RampWindows,
  reduceMotion: boolean
): RampStyle {
  const urgent = remainingMs <= windows.fast;
  const scaleAmt = urgent ? 0.08 : 0.03;
  const glow = (urgent ? 80 : 36) * wave + 18;
  return {
    transform: reduceMotion ? "" : `scale(${1 + wave * scaleAmt})`,
    boxShadow: `0 0 ${glow}px rgba(251,191,36,${0.4 + wave * 0.5})`
  };
}
