// How loud did this clip ever get? Server-only.
//
// The first rule of the silence guard (lib/translate/silenceGuard.ts): a clip
// whose decoded peak never leaves the floor holds no speech, whatever the
// transcriber wrote about it. This is the one signal that does not depend on
// a model's opinion of itself.
//
// It is measured only where that is cheap:
//   - PCM WAV is read directly — a loop over samples, no process spawned.
//     (Quiet-normalize hands the transcriber a WAV; so do the fixtures.)
//   - Everything a phone actually records (Opus in WebM, AAC in MP4) needs a
//     decoder. Where the ffmpeg binary is in the function bundle — it ships
//     with /api/translate and /api/review/redo, see next.config.js — one
//     `volumedetect` pass does it: ~40 ms for a phrase on this machine.
//   - Where there is no ffmpeg (/api/walkie/turn, /api/fast/listen,
//     /api/voz/line, /api/chat/voice today), the answer is null and the guard
//     falls back to the model's own confidence. Shipping an 80 MB binary to
//     four more functions for this was not judged worth it.
//
// transcribeAudio() runs this BESIDE the provider call, never in front of it,
// so a turn that has speech in it pays no latency for the check.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** A level probe slower than this is abandoned; the guard carries on without it. */
export const LEVEL_TIMEOUT_MS = 4000;

/**
 * The ffmpeg binary, or null. The same path lib/translate/normalize.ts
 * resolves — repeated here rather than imported so that a test which mocks
 * the normalize module does not also have to know about this one.
 */
function ffmpegBinary(): string | null {
  const traced = join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");
  return existsSync(traced) ? traced : null;
}

function toDb(peak: number): number {
  // −120 stands in for −∞: digital silence still has to compare as a number.
  return peak <= 0 ? -120 : Math.max(-120, Math.round(20 * Math.log10(peak) * 10) / 10);
}

/**
 * Peak of a 16-bit PCM WAV in dBFS, or null when the bytes are not one.
 * Walks the RIFF chunks rather than assuming a 44-byte header: ffmpeg writes
 * a LIST chunk before `data`.
 */
export function wavPeakDb(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let offset = 12;
  let pcm16 = false;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const declared = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + 16 > bytes.length) return null;
      pcm16 = view.getUint16(body, true) === 1 && view.getUint16(body + 14, true) === 16;
    } else if (id === "data") {
      if (!pcm16) return null;
      // A streamed WAV (ffmpeg to a pipe) declares 0xFFFFFFFF; trust the file.
      const end = Math.min(bytes.length, body + declared);
      let peak = 0;
      for (let i = body; i + 1 < end; i += 2) {
        const a = Math.abs(view.getInt16(i, true));
        if (a > peak) peak = a;
      }
      return toDb(peak / 32768);
    }
    offset = body + declared + (declared % 2);
  }
  return null;
}

/** `max_volume: -23.4 dB` out of volumedetect's stderr, or null. */
function parseMaxVolume(stderr: string): number | null {
  const m = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  return m ? Number(m[1]) : null;
}

function ffmpegPeakDb(bin: string, input: Uint8Array, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(
      bin,
      ["-hide_banner", "-nostdin", "-i", "pipe:0", "-af", "volumedetect", "-vn", "-f", "null", "-"],
      { stdio: ["pipe", "ignore", "pipe"] }
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, timeoutMs);
    let err = "";
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString();
      if (err.length > 65536) err = err.slice(-32768);
    });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? parseMaxVolume(err) : null));
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  });
}

/**
 * The clip's peak in dBFS, or null when it cannot be measured here. Never
 * throws: a level we could not read is not a reason to fail a turn.
 */
export async function measurePeakDb(
  file: File,
  options: { binary?: string | null; timeoutMs?: number } = {}
): Promise<number | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) return null;
    const wav = wavPeakDb(bytes);
    if (wav !== null) return wav;
    const bin = options.binary === undefined ? ffmpegBinary() : options.binary;
    if (!bin) return null;
    return await ffmpegPeakDb(bin, bytes, options.timeoutMs ?? LEVEL_TIMEOUT_MS);
  } catch {
    return null;
  }
}
