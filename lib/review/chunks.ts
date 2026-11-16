// Keeping a CHUNKED home turn for review. Server-only.
//
// A long home turn reaches the server as several recordings
// (lib/translate/longTurn.ts). The review store's shape is one row and ONE
// audio object per kept turn, and everything downstream reads it that way:
// the /review player, Redo, the second opinion, the export tar, and the
// sweep that deletes the object at 14 days. So a chunked turn is kept as one
// file too:
//
//   1. Each PART request (a chunk that closed mid-turn) stages its audio at
//      `<user_id>/parts/<turn_id>.<index>.<ext>` — only for a speaker whose
//      own opt-in is on, exactly as a whole turn is only kept for them.
//   2. The FINAL request downloads the staged parts, joins them with the
//      last chunk into one file (ffmpeg, stream copy — no re-encode, so it
//      is the audio the phone sent), hands that to keepTurnForReview() like
//      any other turn, and removes the staged parts.
//
// A turn whose final request never arrives (the tab was closed mid-turn)
// leaves staged parts with no row. sweepReviewParts() removes any part older
// than a day; it rides the same daily cron as the row sweep. A part
// therefore lives at most ~2 days, never the full retention.
//
// ── ffmpeg ─────────────────────────────────────────────────────────────────
// Joining needs the ffmpeg binary lib/translate/normalize.ts uses, and
// next.config.js leaves it out of /api/translate's bundle when the build has
// TAOS_STT_NORMALIZE=0. Without it a long turn cannot be made into one file,
// and half a turn's audio under a whole turn's transcript would be a review
// row that lies — so canKeepChunkedTurns() is asked FIRST: no ffmpeg, nothing
// is staged, no row is promised (no reviewId, so no Redo button that 404s),
// and the log says `keep_skipped code=no_ffmpeg`. One-recording turns are
// kept exactly as before either way.
//
// Never throws on the request path. Logs are codes and counts only.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { ffmpegPath } from "@/lib/translate/normalize";
import { HOME_MAX_CHUNKS } from "@/lib/translate/longTurn";
import {
  downloadReviewAudio,
  listReviewSpeakers,
  removeReviewAudio,
  REVIEW_BUCKET,
  reviewExtensionFor,
  uploadReviewAudio
} from "./store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A turn id the phone minted, or null when it is not one. */
export function parseTurnId(raw: unknown): string | null {
  return typeof raw === "string" && UUID.test(raw) ? raw.toLowerCase() : null;
}

/** Can this runtime join a long turn's chunks into one file? */
export function canKeepChunkedTurns(): boolean {
  return ffmpegPath() !== null;
}

export const REVIEW_PARTS_FOLDER = "parts";
/** A staged part older than this has no turn coming for it. */
export const REVIEW_PART_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Joining ten minutes of audio is a stream copy — seconds. */
export const REVIEW_CONCAT_TIMEOUT_MS = 45000;

/** `<user_id>/parts/<turn_id>.<index>.<ext>` */
export function reviewPartPath(userId: string, turnId: string, index: number, mime: string): string {
  return `${userId}/${REVIEW_PARTS_FOLDER}/${turnId}.${index}.${reviewExtensionFor(mime)}`;
}

/** Stage one part's audio. Resolves true when it was stored. */
export async function stageReviewPart(input: {
  userId: string;
  turnId: string;
  index: number;
  audio: ArrayBuffer | Uint8Array;
  mime: string;
}): Promise<boolean> {
  if (input.index < 0 || input.index >= HOME_MAX_CHUNKS) return false;
  try {
    await uploadReviewAudio(
      reviewPartPath(input.userId, input.turnId, input.index, input.mime),
      input.audio,
      input.mime || "audio/webm"
    );
    console.log(`[taos-review] part_kept index=${input.index} bytes=${input.audio.byteLength}`);
    return true;
  } catch {
    console.error(`[taos-review] part_keep_failed index=${input.index}`);
    return false;
  }
}

function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Several recordings of one container as one file, in order. Stream copy
 * first; a re-encode in the same codec if the copy is refused. Null when
 * there is no ffmpeg or both fail.
 */
export async function concatAudio(
  parts: Uint8Array[],
  mime: string,
  bin: string | null = ffmpegPath(),
  timeoutMs: number = REVIEW_CONCAT_TIMEOUT_MS
): Promise<Uint8Array | null> {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  if (!bin) return null;
  const ext = reviewExtensionFor(mime);
  const mp4 = ext === "m4a";
  const dir = await mkdtemp(join(tmpdir(), "taos-review-"));
  try {
    const names = parts.map((_, i) => `part${i}.${ext}`);
    await Promise.all(parts.map((bytes, i) => writeFile(join(dir, names[i]), bytes)));
    await writeFile(join(dir, "list.txt"), names.map((n) => `file '${n}'`).join("\n"));
    const out = join(dir, `out.${ext}`);
    const input = ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-vn"];
    const container = mp4 ? ["-f", "mp4", "-movflags", "+faststart"] : ["-f", ext === "webm" ? "webm" : ext];
    const attempts = [
      [...input, "-c", "copy", ...container, out],
      [...input, "-c:a", mp4 ? "aac" : "libopus", "-b:a", "32k", "-ac", "1", ...container, out]
    ];
    for (const args of attempts) {
      try {
        const code = await runFfmpeg(bin, args, timeoutMs);
        if (code !== 0) continue;
        const bytes = await readFile(out);
        if (bytes.byteLength > 0) return new Uint8Array(bytes);
      } catch {
        /* try the next way */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface AssembledAudio {
  bytes: Uint8Array;
  /** How many of the turn's chunks are in it. */
  chunks: number;
}

/**
 * The whole turn's audio: the staged parts 0..priorCount-1 that exist, then
 * the final chunk. The staged parts are removed whatever happens — a turn
 * that could not be assembled does not leave its pieces behind.
 * Null when the pieces could not be made into one file.
 */
export async function assembleReviewAudio(input: {
  userId: string;
  turnId: string;
  priorCount: number;
  finalAudio: Uint8Array | null;
  mime: string;
}): Promise<AssembledAudio | null> {
  const paths = Array.from({ length: Math.min(input.priorCount, HOME_MAX_CHUNKS) }, (_, i) =>
    reviewPartPath(input.userId, input.turnId, i, input.mime)
  );
  try {
    const staged = await Promise.all(paths.map((p) => downloadReviewAudio(p).catch(() => null)));
    const pieces = [...staged, input.finalAudio].filter((b): b is Uint8Array => !!b && b.byteLength > 0);
    if (pieces.length === 0) return null;
    const bytes = await concatAudio(pieces, input.mime);
    return bytes ? { bytes, chunks: pieces.length } : null;
  } catch {
    return null;
  } finally {
    await removeReviewAudio(paths).catch(() => undefined);
  }
}

// ── The orphan sweep ───────────────────────────────────────────────────────

export interface ReviewPartsSweepResult {
  scanned: number;
  removed: number;
  error: string | null;
}

/** Remove every staged part older than a day. Only founders can have any. */
export async function sweepReviewParts(nowMs: number = Date.now()): Promise<ReviewPartsSweepResult> {
  const result: ReviewPartsSweepResult = { scanned: 0, removed: 0, error: null };
  if (!hasServiceRoleKey) {
    result.error = "no_service_role";
    return result;
  }
  try {
    const speakers = await listReviewSpeakers();
    for (const speaker of speakers) {
      const folder = `${speaker.id}/${REVIEW_PARTS_FOLDER}`;
      const { data, error } = await supabaseAdmin.storage.from(REVIEW_BUCKET).list(folder, { limit: 1000 });
      if (error) {
        result.error = "list_failed";
        continue;
      }
      const objects = (data ?? []) as Array<{ name: string; created_at?: string | null }>;
      result.scanned += objects.length;
      const stale = objects
        .filter((o) => {
          const at = o.created_at ? Date.parse(o.created_at) : NaN;
          return Number.isFinite(at) && nowMs - at > REVIEW_PART_MAX_AGE_MS;
        })
        .map((o) => `${folder}/${o.name}`);
      if (stale.length === 0) continue;
      const { data: removed, error: rmErr } = await supabaseAdmin.storage.from(REVIEW_BUCKET).remove(stale);
      if (rmErr) result.error = "remove_failed";
      else result.removed += removed?.length ?? 0;
    }
  } catch {
    result.error = "failed";
  }
  return result;
}
