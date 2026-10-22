// Raw PCM plumbing for the Gemini brain of /tabletop (lib/tabletop/geminiBrain.ts).
//
// Copied from spike/gemini-live-translate @ a2faa41 (lib/call/pcm.ts, closed
// PR #70) with the OUTPUT half removed: the table never plays Gemini's audio
// — it reads the transcript of it and speaks through /api/tts like OpenAI.
//
// Pure functions on sample arrays — no WebAudio, no WebSocket — so the parts
// most likely to be subtly wrong (a resampler that drifts, a sign error in
// the 16-bit conversion) are testable without a phone.
//
// The formats are Gemini Live's, fixed by the API:
//   in   16-bit signed little-endian PCM, mono, 16 kHz, sent in 100 ms chunks
//   (out is 24 kHz PCM; this file has no use for it)

export const PCM_IN_RATE = 16_000;
/** 100 ms at 16 kHz — the chunk size Google recommends. */
export const PCM_IN_CHUNK_SAMPLES = 1_600;

/**
 * Turn the context's float samples (usually 48 kHz, sometimes 44.1) into
 * 16 kHz s16 chunks of exactly PCM_IN_CHUNK_SAMPLES.
 *
 * Box-average decimation: each output sample is the mean of the input
 * samples it spans, which doubles as a crude low-pass so the top octave does
 * not fold back down into the speech band. State carries across `push`
 * calls, including the fractional read position, so a 44.1 kHz context does
 * not drift a sample per block — over an hour that would be the audio clock
 * walking away from wall time, which is the thing `audio_arrival_ms` watches.
 */
export function createPcmDownsampler(
  inRate: number,
  onChunk: (chunk: Int16Array) => void,
  outRate: number = PCM_IN_RATE,
  chunkSamples: number = PCM_IN_CHUNK_SAMPLES
): { push: (input: Float32Array) => void } {
  const ratio = inRate / outRate;
  let chunk = new Int16Array(chunkSamples);
  let filled = 0;
  // Running sum over the input samples of the output sample being built.
  let acc = 0;
  let accN = 0;
  // Where, in input samples, the current output sample ends.
  let boundary = ratio;
  let consumed = 0;

  const emit = (value: number) => {
    chunk[filled++] = floatToS16(value);
    if (filled === chunkSamples) {
      onChunk(chunk);
      chunk = new Int16Array(chunkSamples);
      filled = 0;
    }
  };

  return {
    push: (input) => {
      for (let i = 0; i < input.length; i++) {
        acc += input[i];
        accN += 1;
        consumed += 1;
        if (consumed >= boundary) {
          emit(accN > 0 ? acc / accN : 0);
          acc = 0;
          accN = 0;
          boundary += ratio;
        }
      }
      // Keep the counters small without losing the fraction.
      const whole = Math.floor(consumed);
      consumed -= whole;
      boundary -= whole;
    }
  };
}

export function floatToS16(value: number): number {
  const v = Math.max(-1, Math.min(1, value));
  return v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
}

/** Samples → the little-endian bytes the API expects, whatever the host order. */
export function s16ToLeBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return out;
}

/** Peak amplitude, 0..1. */
export function peakOfS16(samples: Int16Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak / 0x8000;
}

/**
 * Below this peak a chunk is silence. Measured on the spike against Gemini's
 * own output (silence peak 0, speech in the thousands of s16 units); here it
 * marks the speaker's VOICED chunks for the latency clock, after the
 * browser's noise suppression has had its turn.
 */
export const VOICED_PEAK = 500 / 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}
