// Azure Pronunciation Assessment wants 16 kHz mono 16-bit PCM WAV. MediaRecorder
// gives us webm/opus or mp4, so we decode + resample + re-encode in the browser.
export interface Wav16k {
  wav: Blob;
  /** Loudest absolute sample, 0..1. Under lib/study/practice.ts SILENCE_PEAK it is silence. */
  peak: number;
  seconds: number;
}

/**
 * The WAV plus what it is worth knowing before sending it anywhere: how loud
 * it ever got, and how long it is. A live mic can deliver a recording of
 * nothing (iOS leaves a graph silently suspended), and the only place that can
 * be caught for free is here, before Azure is paid to score it.
 */
export async function blobToWav16kWithLevel(blob: Blob): Promise<Wav16k> {
  const arrayBuf = await blob.arrayBuffer();
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  const decoded = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  const targetRate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return { wav: encodeWav(samples, targetRate), peak, seconds: samples.length / targetRate };
}

export async function blobToWav16k(blob: Blob): Promise<Blob> {
  return (await blobToWav16kWithLevel(blob)).wav;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}
