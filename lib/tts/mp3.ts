// Just enough MPEG audio (Layer III) framing to put two MP3s end to end.
//
// Built for the share sign-off (lib/tts/shareSignoff.ts): the shared file is
// [line][150 ms silence][sign-off] as ONE mp3, and an mp3 is a run of
// self-describing frames, so joining two is concatenating their frames —
// provided three things hold, each of which this file checks or fixes:
//
//   * no ID3 tag in the middle — the client writes one tag on the front
//     (lib/tts/id3.ts), so both parts arrive here bare;
//   * no Xing/Info/VBRI frame — that frame states the file's frame count, and
//     a player that trusts it (iOS does) stops at the end of the FIRST part;
//   * one sample rate throughout — a decoder that meets a rate change
//     mid-stream may glitch or stop, so the sign-off is synthesized at the
//     line's rate and a mismatch skips the sign-off instead of risking it.
//
// No decoding happens here: nothing in this file can tell speech from noise
// except by a frame's loudness step (see globalGain).

import { existingTagLength } from "./id3";

export interface Mp3Frame {
  offset: number;
  length: number;
  /** 1 = MPEG-1, 2 = MPEG-2, 2.5 = MPEG-2.5 */
  version: 1 | 2 | 2.5;
  sampleRate: number;
  samplesPerFrame: number;
  mono: boolean;
}

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<string, number[]> = {
  "1": [44100, 48000, 32000],
  "2": [22050, 24000, 16000],
  "2.5": [11025, 12000, 8000]
};

/** The Layer III frame header at `offset`, or null when there isn't one. */
export function parseFrame(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.length) return null;
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  if (versionBits === 0x01 || layerBits !== 0x01) return null; // reserved, or not Layer III
  const version = versionBits === 0x03 ? 1 : versionBits === 0x02 ? 2 : 2.5;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const kbps = (version === 1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex];
  const sampleRate = SAMPLE_RATES[String(version)][rateIndex];
  const padding = (b2 >> 1) & 0x01;
  const samplesPerFrame = version === 1 ? 1152 : 576;
  const length = Math.floor(((samplesPerFrame / 8) * kbps * 1000) / sampleRate) + padding;
  const mono = (bytes[offset + 3] >> 6) === 0x03;
  return { offset, length, version, sampleRate, samplesPerFrame, mono };
}

function sideInfoLength(frame: Mp3Frame): number {
  return frame.version === 1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
}

/** A Xing/Info (LAME) or VBRI header frame: metadata dressed as audio. */
function isInfoFrame(bytes: Uint8Array, frame: Mp3Frame): boolean {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const xing = frame.offset + 4 + sideInfoLength(frame);
  return tag(xing) === "Xing" || tag(xing) === "Info" || tag(frame.offset + 36) === "VBRI";
}

/**
 * Every audio frame in the file, in order, with a leading ID3v2 tag and any
 * Xing/Info/VBRI frame left out. Stops at the first byte that is not a frame
 * (a trailing ID3v1 tag, junk) — what came before is still a valid stream.
 */
export function audioFrames(bytes: Uint8Array): Mp3Frame[] {
  const frames: Mp3Frame[] = [];
  let offset = existingTagLength(bytes);
  // Tolerate a little junk before the first frame, the way players do.
  const searchEnd = Math.min(bytes.length, offset + 4096);
  while (offset < searchEnd && !parseFrame(bytes, offset)) offset += 1;
  for (;;) {
    const frame = parseFrame(bytes, offset);
    if (!frame || frame.offset + frame.length > bytes.length) break;
    if (!(frames.length === 0 && isInfoFrame(bytes, frame))) frames.push(frame);
    offset += frame.length;
  }
  return frames;
}

/**
 * The first granule's global_gain: Layer III's overall loudness step for the
 * frame. An encoder spends its bits on a provider's lead-in hiss as readily as
 * on speech, so the bit count cannot find where speech starts — but the gain
 * jumps when it does (Google Chirp 3: ~137 through the lead-in, 160+ on the
 * first syllable, measured 2026-10-24).
 */
export function globalGain(bytes: Uint8Array, frame: Mp3Frame): number {
  const reader = bitReader(bytes.subarray(frame.offset + 4, frame.offset + 4 + sideInfoLength(frame)));
  if (frame.version === 1) reader.skip(9 + (frame.mono ? 5 : 3) + 4 * (frame.mono ? 1 : 2));
  else reader.skip(8 + (frame.mono ? 1 : 2));
  reader.skip(12 + 9); // part2_3_length, big_values
  return reader.read(8);
}

/**
 * How many frames at each end are the provider's padding silence, less a
 * short margin so a syllable's attack or decay is never clipped. Measured
 * against the quietest of the three outermost frames on each side; an end
 * with no clear rise within its first second is left alone.
 */
export function paddingFrames(
  bytes: Uint8Array,
  frames: Mp3Frame[],
  { rise = 12, marginMs = 60 }: { rise?: number; marginMs?: number } = {}
): { lead: number; trail: number } {
  if (frames.length < 8) return { lead: 0, trail: 0 };
  const frameMs = (frames[0].samplesPerFrame / frames[0].sampleRate) * 1000;
  const margin = Math.ceil(marginMs / frameMs);
  const limit = Math.min(frames.length, Math.ceil(1000 / frameMs));
  const edge = (ordered: Mp3Frame[]) => {
    const floor = Math.min(...ordered.slice(0, 3).map((f) => globalGain(bytes, f)));
    const onset = ordered.slice(0, limit).findIndex((f) => globalGain(bytes, f) >= floor + rise);
    return onset <= 0 ? 0 : Math.max(0, onset - margin);
  };
  const lead = edge(frames);
  const trail = edge([...frames].reverse());
  return lead + trail < frames.length ? { lead, trail } : { lead: 0, trail: 0 };
}

function bitReader(bytes: Uint8Array) {
  let pos = 0;
  return {
    skip(n: number) {
      pos += n;
    },
    read(n: number): number {
      let value = 0;
      for (let i = 0; i < n; i += 1, pos += 1) {
        const byte = bytes[pos >> 3] ?? 0;
        value = (value << 1) | ((byte >> (7 - (pos & 7))) & 1);
      }
      return value;
    }
  };
}

/**
 * `ms` of digital silence in the same format as `like`: frames whose side
 * information is all zero code no audio at all, which every decoder renders
 * as silence. Padding bit cleared so every frame is the same length.
 */
export function silenceFrames(bytes: Uint8Array, like: Mp3Frame, ms: number): Uint8Array {
  const header = bytes.slice(like.offset, like.offset + 4);
  header[2] &= ~0x02; // no padding
  header[1] |= 0x01; // no CRC, so the side info starts right after the header
  const length = parseFrame(header, 0)?.length ?? like.length;
  const count = Math.max(1, Math.ceil((ms / 1000) * (like.sampleRate / like.samplesPerFrame)));
  const out = new Uint8Array(length * count);
  for (let i = 0; i < count; i += 1) out.set(header, i * length);
  return out;
}

/**
 * A Xing header frame saying how many frames and bytes follow. A joined file
 * changes bitrate where the sign-off starts (a 128 kbps line, a 32 kbps
 * Google clip), and without this frame a player estimates the length from the
 * FIRST frame's bitrate — ffprobe read a 5.3 s share as 3.9 s. With it, the
 * length is counted rather than guessed. Shaped like `like` so it sits in
 * the stream as one more (silent) frame to anything that doesn't read it.
 */
export function xingFrame(bytes: Uint8Array, like: Mp3Frame, frameCount: number, byteCount: number): Uint8Array {
  const header = bytes.slice(like.offset, like.offset + 4);
  header[2] &= ~0x02; // no padding
  header[1] |= 0x01; // no CRC
  const parsed = parseFrame(header, 0) ?? like;
  const out = new Uint8Array(parsed.length);
  out.set(header, 0);
  const at = 4 + sideInfoLength(parsed);
  const view = new DataView(out.buffer);
  out.set([0x58, 0x69, 0x6e, 0x67], at); // "Xing"
  view.setUint32(at + 4, 0x03); // frames + bytes fields present
  view.setUint32(at + 8, frameCount);
  view.setUint32(at + 12, byteCount + out.length);
  return out;
}

/** The bytes of `frames`, end to end. */
export function frameBytes(bytes: Uint8Array, frames: Mp3Frame[]): Uint8Array {
  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const f of frames) {
    out.set(bytes.subarray(f.offset, f.offset + f.length), at);
    at += f.length;
  }
  return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
