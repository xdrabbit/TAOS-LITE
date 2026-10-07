// One record per /api/tts request: which engine and voice id spoke, for whom,
// from what kind of device (10/07).
//
// Built for Tom's report that Fish Audio sounded like a DIFFERENT voice on his
// phone than on his computer, with ElevenLabs the same on both. Until this
// file the route logged nothing on success, so "which voice id did the phone
// get?" had no answer. Two sinks:
//   * a `[taos-tts]` line in the Vercel runtime log, success and failure alike
//     — read for a day, then gone;
//   * a row in public.taos_lite_tts_log (20261007_tts_request_log.sql) — the
//     durable record.
//
// What is NOT recorded, on purpose: the text (only its length), the email
// (only the auth uuid), and the raw User-Agent (only a parsed family/browser
// and a short hash that tells two devices apart).
//
// LOGGING MUST NEVER BREAK TTS. writeTtsLog never throws and never rejects;
// a failed or slow insert is a console.warn, and the audio has already gone.

import { createHash } from "node:crypto";
import type { TtsProvider, VoiceRole } from "./voice";
import type { TtsSurface } from "./deviceHints";

export {
  TTS_STANDALONE_HEADER,
  TTS_SURFACE_HEADER,
  parseStandalone,
  parseSurface
} from "./deviceHints";

export type DeviceFamily = "iPhone" | "iPad" | "Android" | "Mac" | "Windows" | "Linux" | "other";
export type BrowserFamily = "Safari" | "Chrome" | "Firefox" | "other";

/**
 * Device and browser from a User-Agent, coarse on purpose.
 *
 * Two known blind spots, both WebKit's doing:
 *   * iPadOS 13+ Safari sends a Mac UA, so an iPad usually reads "Mac".
 *     `standalone` and `ua_hash` still separate it from a real Mac.
 *   * Every iOS browser is WebKit. Chrome and Firefox on an iPhone announce
 *     themselves (CriOS / FxiOS) and are named; an installed Home Screen app
 *     drops the "Safari/" token entirely and is still Safari.
 */
export function parseUserAgent(ua: string | null | undefined): {
  device: DeviceFamily;
  browser: BrowserFamily;
} {
  const s = ua ?? "";
  const device: DeviceFamily = /iPhone|iPod/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /Macintosh|Mac OS X/.test(s)
          ? "Mac"
          : /Windows/.test(s)
            ? "Windows"
            : /Linux|X11|CrOS/.test(s)
              ? "Linux"
              : "other";

  let browser: BrowserFamily = "other";
  if (/Edg(e|A|iOS)?\/|OPR\/|SamsungBrowser\//.test(s)) browser = "other";
  else if (/CriOS\/|Chrome\//.test(s)) browser = "Chrome";
  else if (/FxiOS\/|Firefox\//.test(s)) browser = "Firefox";
  else if (/Safari\//.test(s) || (/AppleWebKit\//.test(s) && /iPhone|iPad|iPod/.test(s))) {
    browser = "Safari";
  }
  return { device, browser };
}

/** 12 hex chars of SHA-256: tells two devices apart, says nothing else. */
export function uaHash(ua: string | null | undefined): string | null {
  if (!ua) return null;
  return createHash("sha256").update(ua).digest("hex").slice(0, 12);
}

export interface TtsLogRecord {
  userId: string | null;
  surface: TtsSurface;
  /** The provider that actually spoke (Fish with no clone is elevenlabs). */
  engine: TtsProvider | null;
  /** The engine the client asked for, when it differs from `engine`. */
  requestedEngine: string | null;
  voiceId: string | null;
  voiceRole: VoiceRole | "none";
  unlocked: boolean;
  lang: string | null;
  sourceLang: string | null;
  textChars: number;
  device: DeviceFamily;
  browser: BrowserFamily;
  standalone: boolean;
  uaHash: string | null;
  status: "ok" | "error";
  httpStatus: number;
  errorCode: string | null;
  latencyMs: number;
  audioBytes: number | null;
  audioMime: string | null;
}

/** Only these characters survive into the log line. */
function token(value: unknown): string {
  return typeof value === "string" && value
    ? value.replace(/[^0-9A-Za-z_.:-]/g, "").slice(0, 40) || "?"
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "?";
}

/** Flat key=value, same shape as `[taos-call-cost]`. */
export function ttsLogLine(r: TtsLogRecord): string {
  const fields: [string, unknown][] = [
    ["status", r.status],
    ["http", r.httpStatus],
    ["engine", r.engine],
    ["requested", r.requestedEngine],
    ["voice_id", r.voiceId],
    ["voice_role", r.voiceRole],
    ["unlocked", r.unlocked],
    ["device", r.device],
    ["browser", r.browser],
    ["standalone", r.standalone],
    ["ua", r.uaHash],
    ["surface", r.surface],
    ["lang", r.lang],
    ["src", r.sourceLang],
    ["chars", r.textChars],
    ["ms", r.latencyMs],
    ["bytes", r.audioBytes],
    ["err", r.errorCode],
    ["user", r.userId]
  ];
  return ["[taos-tts]", ...fields.map(([k, v]) => `${k}=${token(v)}`)].join(" ");
}

/** The row, in the table's column names. */
export function ttsLogRow(r: TtsLogRecord): Record<string, unknown> {
  return {
    user_id: r.userId,
    surface: r.surface,
    engine: r.engine,
    requested_engine: r.requestedEngine,
    voice_id: r.voiceId,
    voice_role: r.voiceRole,
    unlocked: r.unlocked,
    lang: r.lang,
    source_lang: r.sourceLang,
    text_chars: r.textChars,
    device_family: r.device,
    browser: r.browser,
    standalone: r.standalone,
    ua_hash: r.uaHash,
    status: r.status,
    http_status: r.httpStatus,
    error_code: r.errorCode,
    latency_ms: r.latencyMs,
    audio_bytes: r.audioBytes,
    audio_mime: r.audioMime
  };
}

/** The insert, injectable so a test can make it fail or hang. */
export type TtsLogInsert = (row: Record<string, unknown>, signal: AbortSignal) => Promise<void>;

export const TTS_LOG_TIMEOUT_MS = 3000;

async function supabaseInsert(row: Record<string, unknown>, signal: AbortSignal): Promise<void> {
  const { supabaseAdmin, hasServiceRoleKey } = await import("@/lib/supabaseAdmin");
  if (!hasServiceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  const { error } = await supabaseAdmin.from("taos_lite_tts_log").insert(row).abortSignal(signal);
  if (error) throw new Error(error.message);
}

/**
 * Print the line, then write the row (unless `insert` is null). Resolves
 * either way — never rejects — and gives up on the insert after `timeoutMs`.
 */
export async function writeTtsLog(
  record: TtsLogRecord,
  insert: TtsLogInsert | null = supabaseInsert,
  timeoutMs = TTS_LOG_TIMEOUT_MS
): Promise<void> {
  try {
    console.log(ttsLogLine(record));
    if (!insert) return; // line only
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      await Promise.race([insert(ttsLogRow(record), controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    try {
      console.warn(`[taos-tts] log insert failed: ${e instanceof Error ? e.message : String(e)}`);
    } catch {
      // nothing left to do — the audio is what matters
    }
  }
}
