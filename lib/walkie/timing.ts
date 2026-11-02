// [taos-walkie-timing] — the line that proves the bet or kills it.
//
// Taokie exists on one claim: a hold-talk-release turn reaches the other
// phone, translated and spoken, faster than a WhatsApp voice note. The
// timing line is how that claim is measured on real phones:
//
//   rec_ms               how long the button was held (sender's clock)
//   upload_ms            reading the multipart body on the server
//   transcribe_ms        speech → text
//   translate_ms         text → the partner's language
//   tts_ms               the partner's language → the sender's voice
//   deliver_ms           partner: "ready" heard → audio playing
//   release_to_play_ms   sender's release → partner's playback (two clocks)
//   busy_blocked         presses refused because the channel was busy
//   cancelled            1 when pointercancel ended the hold (sent anyway)
//
// Two emitters, one format. The turn route knows the server phases and logs
// the line with deliver_ms / release_to_play_ms as "?"; the partner's played
// ack carries those two and the ack route logs the line complete. The format
// is pure so the test can assert the one rule that matters: NO message text,
// no email, no raw user agent — numbers and short codes only.

export interface WalkieTimingFields {
  status: "ok" | "error";
  http: number;
  recMs: number | "?";
  uploadMs: number | "?";
  transcribeMs: number | "?";
  translateMs: number | "?";
  ttsMs: number | "?";
  deliverMs: number | "?";
  releaseToPlayMs: number | "?";
  busyBlocked: number | "?";
  cancelled: 0 | 1 | "?";
  src: string;
  tgt: string;
  audioBytes: number | "?";
  srcChars: number | "?";
  outChars: number | "?";
  totalMs: number | "?";
  err: string;
}

export const WALKIE_TIMING_PREFIX = "[taos-walkie-timing]";

/** `transcribe_timeout`, `translate_502`, … — a code, never a message. */
export function walkieErrorCode(stage: string, e: unknown): string {
  if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return `${stage}_timeout`;
  }
  const status = (e as { upstreamStatus?: unknown } | null)?.upstreamStatus;
  if (typeof status === "number") return `${stage}_${status}`;
  return `${stage}_failed`;
}

// A value on the line is a number, "?", or a short token of safe characters.
// Anything else — a sentence, an address, a user agent — is clipped to the
// safe alphabet and 32 characters, so even a bug upstream cannot put text here.
function token(v: number | string): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v)) : "?";
  const clean = v.replace(/[^0-9A-Za-z_.:?-]/g, "").slice(0, 32);
  return clean || "?";
}

export function formatWalkieTiming(f: WalkieTimingFields): string {
  return (
    `${WALKIE_TIMING_PREFIX} status=${f.status} http=${token(f.http)}` +
    ` rec_ms=${token(f.recMs)} upload_ms=${token(f.uploadMs)}` +
    ` transcribe_ms=${token(f.transcribeMs)} translate_ms=${token(f.translateMs)}` +
    ` tts_ms=${token(f.ttsMs)} deliver_ms=${token(f.deliverMs)}` +
    ` release_to_play_ms=${token(f.releaseToPlayMs)} busy_blocked=${token(f.busyBlocked)}` +
    ` cancelled=${token(f.cancelled)} src=${token(f.src)} tgt=${token(f.tgt)}` +
    ` audio_bytes=${token(f.audioBytes)} src_chars=${token(f.srcChars)}` +
    ` out_chars=${token(f.outChars)} total_ms=${token(f.totalMs)} err=${token(f.err)}`
  );
}

/** What the turn route keeps on the row so the played ack can finish the line. */
export interface StoredTimings {
  rec_ms?: number;
  upload_ms?: number;
  transcribe_ms?: number;
  translate_ms?: number;
  tts_ms?: number;
  total_ms?: number;
  busy_blocked?: number;
  cancelled?: 0 | 1;
}

/** Read a stored timings object back, trusting nothing about its shape. */
export function readStoredTimings(raw: unknown): StoredTimings {
  const out: StoredTimings = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const num = (k: keyof StoredTimings): void => {
    const v = r[k];
    if (typeof v === "number" && Number.isFinite(v)) (out as Record<string, number>)[k] = v;
  };
  num("rec_ms");
  num("upload_ms");
  num("transcribe_ms");
  num("translate_ms");
  num("tts_ms");
  num("total_ms");
  num("busy_blocked");
  if (r.cancelled === 0 || r.cancelled === 1) out.cancelled = r.cancelled;
  return out;
}
