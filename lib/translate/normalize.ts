// Quiet normalize: lift a quiet recording to a sane peak before it goes to
// the transcriber. Server-only (spawns ffmpeg).
//
// Why: the 11/5 car clip (see lib/translate/shortTranscript.ts) was Liz
// speaking Spanish from the passenger seat into Tom's phone — far from the
// mic, under road noise. A transcriber that gives up on quiet speech gives
// up less on speech at a normal level. Peak normalization is the cheap,
// honest version of that: one gain, no compression, no filtering, so the
// words are the same words, only louder.
//
// ── How ────────────────────────────────────────────────────────────────────
// Two ffmpeg passes on the clip, both fast (a one-minute opus clip decodes
// in well under a second):
//   1. `-af volumedetect` — reports the peak (max_volume, dBFS) and, as a
//      side effect, the decoded length, which MediaRecorder's WebM never
//      writes in its header.
//   2. `-af volume=<gain>dB` → 16 kHz mono 16-bit WAV, which every
//      transcriber accepts and which is itself the decoded PCM.
// The gain targets a −1 dBFS peak, is capped at +30 dB (a clip that quiet is
// silence, and 30 dB of gain on silence is 30 dB of hiss), and is skipped
// below 1 dB (nothing to fix). It only ever boosts; a hot clip is left
// alone, because clipping has already happened and attenuating it hides
// nothing.
//
// ── Where ffmpeg comes from ────────────────────────────────────────────────
// ffmpeg-static, which /api/video/process already ships (next.config.js
// outputFileTracingIncludes; the same include covers this route). No system
// ffmpeg exists on Vercel. If the binary is not there, normalize is a no-op
// that says so (`norm_gain_db=na` on the timing line) — the turn is never
// failed over its loudness.
//
// ── The flag ───────────────────────────────────────────────────────────────
// TAOS_STT_NORMALIZE: "1" for everyone, "0" for nobody, unset → founders
// only, so the two people who can hear the difference measure it first.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isFounder } from "@/lib/release";

export const NORMALIZE_TARGET_PEAK_DB = -1;
export const NORMALIZE_MAX_GAIN_DB = 30;
export const NORMALIZE_MIN_GAIN_DB = 1;
/** Both passes together must finish inside this, or the original audio is used. */
export const NORMALIZE_TIMEOUT_MS = 20000;
const WAV_RATE = 16000;
const WAV_BYTES_PER_SECOND = WAV_RATE * 2; // mono, 16-bit
const WAV_HEADER_BYTES = 44;

/** Should this caller's audio be normalized? */
export function sttNormalizeEnabled(
  email: string | null | undefined,
  raw: string | undefined = process.env.TAOS_STT_NORMALIZE
): boolean {
  const v = (raw ?? "").trim();
  if (v === "1") return true;
  if (v === "0") return false;
  return isFounder(email);
}

/** The ffmpeg binary, or null when this runtime has none. */
export function ffmpegPath(): string | null {
  // Resolved by path, not require(): ffmpeg-static's module-level resolution
  // breaks under bundling (see next.config.js), and a missing binary must be
  // a null here, never a thrown ENOENT on the request path.
  const traced = join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");
  if (existsSync(traced)) return traced;
  return null;
}

/** Peak → gain, in dB: pure, so the arithmetic is testable without audio. */
export function gainForPeak(maxVolumeDb: number): number {
  if (!Number.isFinite(maxVolumeDb)) return 0;
  const gain = NORMALIZE_TARGET_PEAK_DB - maxVolumeDb;
  if (gain < NORMALIZE_MIN_GAIN_DB) return 0;
  return Math.min(NORMALIZE_MAX_GAIN_DB, Math.round(gain * 10) / 10);
}

/** `max_volume: -23.4 dB` out of volumedetect's stderr, or null. */
export function parseMaxVolume(stderr: string): number | null {
  const m = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  return m ? Number(m[1]) : null;
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

function run(bin: string, args: string[], input: Uint8Array, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString();
      if (err.length > 65536) err = err.slice(-32768);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: err, code });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  });
}

export interface NormalizeResult {
  /** The audio to transcribe: the normalized WAV, or the original when nothing changed. */
  file: File;
  /** Gain applied in dB; 0 when the clip was already loud enough. */
  gainDb: number;
  /** Decoded length of the clip, in seconds (the first pass measures it). */
  seconds: number | null;
  /** Wall time of both passes. */
  ms: number;
}

/**
 * Normalize one clip. Resolves to null — never throws — when ffmpeg is
 * absent, times out, or fails; the caller then transcribes the original.
 */
export async function normalizeForStt(
  file: File,
  options: { binary?: string | null; timeoutMs?: number } = {}
): Promise<NormalizeResult | null> {
  const bin = options.binary === undefined ? ffmpegPath() : options.binary;
  if (!bin) return null;
  const timeoutMs = options.timeoutMs ?? NORMALIZE_TIMEOUT_MS;
  const t0 = performance.now();
  try {
    const input = new Uint8Array(await file.arrayBuffer());
    const deadline = t0 + timeoutMs;
    const probe = await run(
      bin,
      ["-hide_banner", "-nostdin", "-i", "pipe:0", "-af", "volumedetect", "-vn", "-f", "null", "-"],
      input,
      timeoutMs
    );
    const peak = parseMaxVolume(probe.stderr);
    if (probe.code !== 0 || peak === null) return null;
    const gainDb = gainForPeak(peak);
    const seconds = parseDecodedSeconds(probe.stderr);
    if (gainDb === 0) {
      return { file, gainDb: 0, seconds, ms: Math.round(performance.now() - t0) };
    }
    const left = Math.max(1000, Math.round(deadline - performance.now()));
    const out = await run(
      bin,
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        "pipe:0",
        "-vn",
        "-af",
        `volume=${gainDb}dB`,
        "-ac",
        "1",
        "-ar",
        String(WAV_RATE),
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "pipe:1"
      ],
      input,
      left
    );
    if (out.code !== 0 || out.stdout.length <= WAV_HEADER_BYTES) return null;
    const wav = new File([new Uint8Array(out.stdout)], "turn.wav", { type: "audio/wav" });
    const decoded = (out.stdout.length - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND;
    return {
      file: wav,
      gainDb,
      seconds: seconds ?? Math.round(decoded * 100) / 100,
      ms: Math.round(performance.now() - t0)
    };
  } catch {
    return null;
  }
}

/**
 * The decoded length from ffmpeg's progress line (`time=00:01:09.02`), which
 * is the only honest duration for a MediaRecorder WebM: its header says N/A.
 */
export function parseDecodedSeconds(stderr: string): number | null {
  const times = [...stderr.matchAll(/time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/g)];
  if (times.length === 0) return null;
  const last = times[times.length - 1];
  const s = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  return Number.isFinite(s) && s > 0 ? Math.round(s * 100) / 100 : null;
}
