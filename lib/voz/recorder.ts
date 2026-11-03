// Browser-side pieces both voice-clone screens (/demo, /voz) share: what the
// recorder records in, what the file is called, and the unload beacon that
// deletes the voice when the page goes away.

/** Same candidates as the home screen; opus first, AAC for iOS. */
export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const c of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"]) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

export function fileNameFor(mime: string, stem: string): string {
  return mime.includes("mp4") || mime.includes("aac") ? `${stem}.mp4` : `${stem}.webm`;
}

/** Twice the home screen's bitrate: this recording becomes a voice. */
export const SAMPLE_BITS_PER_SECOND = 64000;

/**
 * Fire-and-forget delete on page unload. text/plain keeps the beacon a
 * "simple" request; the route parses it. Falls back to a keepalive fetch.
 * The server's ten-minute sweep is the backstop if both miss.
 */
export function sendCleanupBeacon(url: string, body: string): void {
  try {
    const sent =
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
    if (!sent) void fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
  } catch {
    // The sweep is the backstop.
  }
}
