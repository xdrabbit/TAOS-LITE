// Did this recording capture anything at all? Browser-only, and the SECOND
// line of defence — the server's silence guard (lib/translate/silenceGuard.ts)
// is the one that counts.
//
// What this is for: the dead microphone. A muted input, a Bluetooth headset
// that dropped, an iOS mic left silently suspended — the recorder runs, the
// clip has a length, and every sample in it is (near) zero. Sending that costs
// a transcription and, before 2026-11-27, could come back as a sentence. The
// phone can know it for free and say "check the mic" instead.
//
// What this is NOT for: deciding whether somebody spoke. A quiet room is not
// silence in this sense, and neither is a whisper. The floor is −60 dBFS
// peak across the WHOLE clip — one sample above it and the clip goes to the
// server, which has better evidence.
//
// ── iPhone, and why this is built the way it is ────────────────────────────
// The home mic is a plain MediaRecorder on purpose (lib/translate/recorder.ts,
// lib/translate/chunkedRecorder.ts: "no AudioContext … nothing WebKit can
// suspend"). A live level meter would put a WebAudio graph on the microphone,
// and on iOS a graph that is silently suspended reads as all zeros — a meter
// that calls real speech silent is worse than no meter. So nothing here
// touches the live stream. The finished clip is decoded AFTER the recorder
// has stopped, on an OfflineAudioContext, which has no hardware, no audio
// session, and no gesture rule.
//
// iOS input processing works in this check's favour: Safari's capture path
// applies automatic gain, so a silent room on an iPhone records a noise floor
// well above −60 dBFS and is never blocked here. Only true digital silence
// is, which on a phone means the mic was not delivering.
//
// Every doubt resolves to "send it": no decoder, a decode error, a decode
// that takes too long, a clip too long to decode cheaply, a decoded length
// that does not match the stopwatch.

/** Loudest absolute sample (0..1) under which a whole clip is silence: −60 dBFS. */
export const CLIP_SILENCE_PEAK = 0.001;
/** Longer clips are not decoded on the phone — memory, and the server has them anyway. */
export const CLIP_SILENCE_MAX_MS = 30000;
/** A decode slower than this is abandoned and the clip is sent. */
export const CLIP_SILENCE_TIMEOUT_MS = 800;

export type ClipLevel =
  | { known: true; peak: number; seconds: number }
  | { known: false; why: "too_long" | "no_decoder" | "decode_failed" | "timeout" | "length_mismatch" };

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineContext(): OfflineAudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor(1, 1, 44100);
  } catch {
    return null;
  }
}

function decode(ctx: OfflineAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  // Callback form AND the returned promise: old WebKit only has the former.
  return new Promise((resolve, reject) => {
    try {
      const maybe = ctx.decodeAudioData(bytes, resolve, reject) as Promise<AudioBuffer> | undefined;
      if (maybe && typeof maybe.then === "function") maybe.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

/** The loudest absolute sample in a decoded buffer, stopping early once it clears `stopAbove`. */
export function bufferPeak(buffer: Pick<AudioBuffer, "numberOfChannels" | "getChannelData">, stopAbove = 1): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) {
      const a = Math.abs(data[i]);
      if (a > peak) {
        peak = a;
        if (peak > stopAbove) return peak;
      }
    }
  }
  return peak;
}

/** Measure a finished recording. Never throws. */
export async function measureClipLevel(blob: Blob, recMs: number): Promise<ClipLevel> {
  if (!(recMs > 0) || recMs > CLIP_SILENCE_MAX_MS) return { known: false, why: "too_long" };
  const ctx = offlineContext();
  if (!ctx) return { known: false, why: "no_decoder" };
  try {
    const bytes = await blob.arrayBuffer();
    const decoded = await Promise.race([
      decode(ctx, bytes),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CLIP_SILENCE_TIMEOUT_MS))
    ]);
    if (!decoded) return { known: false, why: "timeout" };
    // A decoder that returned a fraction of the clip (or nothing) has not
    // told us about the clip. Half the stopwatch is generous on purpose.
    if (!(decoded.duration > 0) || decoded.duration * 1000 < recMs * 0.5) {
      return { known: false, why: "length_mismatch" };
    }
    return { known: true, peak: bufferPeak(decoded, CLIP_SILENCE_PEAK), seconds: decoded.duration };
  } catch {
    return { known: false, why: "decode_failed" };
  }
}

/** Pure: only a clip we actually measured, and found under the floor, is silent. */
export function isSilentLevel(level: ClipLevel): boolean {
  return level.known && level.peak < CLIP_SILENCE_PEAK;
}

/**
 * True only when the clip was decoded, matched its length, and never left the
 * floor. Anything else — including every failure — is false: send it.
 */
export async function isClipSilent(blob: Blob, recMs: number): Promise<boolean> {
  return isSilentLevel(await measureClipLevel(blob, recMs));
}
