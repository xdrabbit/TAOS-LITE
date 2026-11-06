// Quiet normalize (lib/translate/normalize.ts): a peak-normalize pass before
// transcription, through the real ffmpeg-static binary npm installs. Pins:
//
//   1. the gain arithmetic: −1 dBFS target, +30 dB cap, nothing under 1 dB,
//      and never a cut
//   2. a quiet clip comes back louder with the SAME length; a loud clip
//      comes back untouched
//   3. no binary → null, never a throw
//   4. the flag: 1 = everyone, 0 = nobody, unset = founders only
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NORMALIZE_MAX_GAIN_DB,
  ffmpegPath,
  gainForPeak,
  normalizeForStt,
  parseDecodedSeconds,
  parseMaxVolume,
  sttNormalizeEnabled
} from "@/lib/translate/normalize";

/** A 16 kHz mono 16-bit WAV of a 440 Hz sine at `amplitude` (0..1), `seconds` long. */
function sineWav(seconds: number, amplitude: number): File {
  const rate = 16000;
  const n = Math.round(seconds * rate);
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * amplitude * 32767);
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  return new File([header, data.buffer as ArrayBuffer], "in.wav", { type: "audio/wav" });
}

function peakOf(wav: ArrayBuffer): number {
  const pcm = new Int16Array(wav.slice(44));
  let max = 0;
  for (const s of pcm) max = Math.max(max, Math.abs(s));
  return max / 32767;
}

const TOM = ["xdrabbit", "gmail.com"].join("@");

describe("gain arithmetic", () => {
  it("targets −1 dBFS, caps at +30, skips under 1 dB, never cuts", () => {
    expect(gainForPeak(-21)).toBe(20);
    expect(gainForPeak(-1.5)).toBe(0);
    expect(gainForPeak(-2)).toBe(1);
    expect(gainForPeak(-60)).toBe(NORMALIZE_MAX_GAIN_DB);
    expect(gainForPeak(0)).toBe(0);
    expect(gainForPeak(Number.NaN)).toBe(0);
  });

  it("reads ffmpeg's volumedetect and progress lines", () => {
    expect(parseMaxVolume("[Parsed_volumedetect_0 @ 0x1] mean_volume: -30.1 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -17.4 dB\n")).toBe(-17.4);
    expect(parseMaxVolume("nothing")).toBeNull();
    expect(parseDecodedSeconds("size=N/A time=00:00:30.00 bitrate=N/A speed=100x\nsize=N/A time=00:01:09.02 bitrate=N/A")).toBe(69.02);
    expect(parseDecodedSeconds("")).toBeNull();
  });
});

describe("the flag", () => {
  it("1 = everyone, 0 = nobody, unset = founders only", () => {
    expect(sttNormalizeEnabled("nobody@example.com", "1")).toBe(true);
    expect(sttNormalizeEnabled(TOM, "0")).toBe(false);
    expect(sttNormalizeEnabled(TOM, undefined)).toBe(true);
    expect(sttNormalizeEnabled("nobody@example.com", undefined)).toBe(false);
    expect(sttNormalizeEnabled(null, "")).toBe(false);
  });
});

describe("normalizeForStt", () => {
  it("no binary → null, never a throw", async () => {
    expect(await normalizeForStt(sineWav(1, 0.1), { binary: null })).toBeNull();
    expect(await normalizeForStt(sineWav(1, 0.1), { binary: "/nonexistent/ffmpeg" })).toBeNull();
  });

  it("a quiet clip comes back louder, as 16 kHz mono WAV, with the same duration", async () => {
    const bin = ffmpegPath();
    expect(bin && existsSync(bin)).toBe(true);
    const quiet = sineWav(3, 0.05); // −26 dBFS
    const out = await normalizeForStt(quiet);
    expect(out).not.toBeNull();
    expect(out!.gainDb).toBeGreaterThanOrEqual(24);
    expect(out!.gainDb).toBeLessThanOrEqual(26);
    expect(out!.file.type).toBe("audio/wav");
    expect(out!.seconds).toBeCloseTo(3, 1);
    const bytes = await out!.file.arrayBuffer();
    const samples = (bytes.byteLength - 44) / 2;
    expect(Math.abs(samples - 3 * 16000)).toBeLessThan(16000 * 0.05); // within 50 ms
    const peak = peakOf(bytes);
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThanOrEqual(1);
    expect(out!.ms).toBeGreaterThan(0);
  }, 30000);

  it("a loud clip is left exactly as it was", async () => {
    const loud = sineWav(2, 0.95);
    const out = await normalizeForStt(loud);
    expect(out).not.toBeNull();
    expect(out!.gainDb).toBe(0);
    expect(out!.file).toBe(loud);
    expect(out!.seconds).toBeCloseTo(2, 1);
  }, 30000);
});
