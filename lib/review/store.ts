// Where a review turn lives, and for how long. Server-only: the table has
// RLS enabled and NO policies, so the service role is the only reader and
// writer and these functions are the only door (the lib/walkie/store.ts
// pattern, supabase/migrations/20261104_review_turns.sql).
//
// ── Shape ──────────────────────────────────────────────────────────────────
// One row per KEPT turn in public.taos_lite_review_turns: the speaker, both
// languages, the transcript, the translation, the models, the timings, the
// flag, and one object in the private `review-audio` bucket — the speaker's
// recording, copied at turn time. The home-history row (taos_lite_translations)
// is untouched: it never had audio and still does not.
//
// ── Retention ──────────────────────────────────────────────────────────────
// `expires_at` is stamped at insert from TAOS_REVIEW_RETENTION_DAYS
// (lib/review/flag.ts). The sweep deletes the storage objects FIRST and the
// rows second — Postgres can never delete from storage.objects (memory:
// data-hygiene), so a row-only delete would strand the audio.

import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { founderEmails } from "@/lib/release";
import { reviewExpiresAt, reviewRetentionDays, type FlagReason, type ReviewSurface } from "./flag";
import type { ReviewOpinion } from "./opinion";

export const REVIEW_TABLE = "taos_lite_review_turns";
export const REVIEW_BUCKET = "review-audio";
export const REVIEW_KEEP_AUDIO_COLUMN = "review_keep_audio";
/** How many turns the page loads per request. */
export const REVIEW_LIST_LIMIT = 200;
/** How long a signed audio link lives. */
export const REVIEW_SIGNED_URL_SECONDS = 3600;

export function reviewExtensionFor(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

/** `<user_id>/<id>.<ext>` — speaker first, so one person's clips are one folder. */
export function reviewAudioPath(userId: string, id: string, mime: string): string {
  return `${userId}/${id}.${reviewExtensionFor(mime)}`;
}

export interface ReviewTimings {
  rec_ms?: number;
  transcribe_ms?: number;
  translate_ms?: number;
  tts_ms?: number;
  total_ms?: number;
}

export interface ReviewTurnRow {
  id: string;
  user_id: string;
  surface: ReviewSurface;
  mode: "manual" | "auto";
  source_lang: string;
  target_lang: string;
  original_text: string;
  translation_text: string;
  segments: unknown | null;
  audio_path: string;
  audio_mime: string | null;
  audio_bytes: number | null;
  rec_ms: number | null;
  transcribe_model: string | null;
  translate_model: string | null;
  timings: ReviewTimings;
  flag_reason: FlagReason | null;
  flag_note: string;
  flagged_at: string | null;
  flagged_by: string | null;
  /** The second opinion (lib/review/opinion.ts). All three null = unreviewed. */
  opinion: ReviewOpinion | null;
  opinion_score: number | null;
  opinion_at: string | null;
  created_at: string;
  expires_at: string;
}

export interface NewReviewTurn {
  id: string;
  userId: string;
  surface: ReviewSurface;
  mode: "manual" | "auto";
  sourceLang: string;
  targetLang: string;
  originalText: string;
  translationText: string;
  segments: unknown | null;
  audioPath: string;
  audioMime: string;
  audioBytes: number;
  recMs: number | null;
  transcribeModel: string | null;
  translateModel: string | null;
  timings: ReviewTimings;
}

export class ReviewStoreError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "ReviewStoreError";
  }
}

function requireAdmin(): void {
  if (!hasServiceRoleKey) {
    throw new ReviewStoreError("Server is missing SUPABASE_SERVICE_ROLE_KEY.", "no_service_role");
  }
}

// ── The opt-in ─────────────────────────────────────────────────────────────
// Read for ONE user — the speaker — and nobody else. Default off, and off on
// any doubt: a missing row, a missing column, an error.

export async function readReviewKeepAudio(userId: string): Promise<boolean> {
  requireAdmin();
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select(REVIEW_KEEP_AUDIO_COLUMN)
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new ReviewStoreError(`Could not read the setting: ${error.message}`, "settings_read_failed");
  const v = (data as Record<string, unknown> | null)?.[REVIEW_KEEP_AUDIO_COLUMN];
  return v === true;
}

export async function writeReviewKeepAudio(userId: string, value: boolean): Promise<void> {
  requireAdmin();
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ [REVIEW_KEEP_AUDIO_COLUMN]: value })
    .eq("id", userId);
  if (error) throw new ReviewStoreError(`Could not save the setting: ${error.message}`, "settings_write_failed");
}

// ── Objects ────────────────────────────────────────────────────────────────

export async function uploadReviewAudio(path: string, bytes: ArrayBuffer | Uint8Array, mime: string): Promise<void> {
  requireAdmin();
  const { error } = await supabaseAdmin.storage
    .from(REVIEW_BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw new ReviewStoreError(`Could not store audio: ${error.message}`, "upload_failed");
}

export async function removeReviewAudio(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  requireAdmin();
  await supabaseAdmin.storage.from(REVIEW_BUCKET).remove(paths);
}

export async function signReviewAudio(path: string | null): Promise<string | null> {
  if (!path) return null;
  requireAdmin();
  const { data, error } = await supabaseAdmin.storage
    .from(REVIEW_BUCKET)
    .createSignedUrl(path, REVIEW_SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** The bytes of one clip, for the export. */
export async function downloadReviewAudio(path: string): Promise<Uint8Array> {
  requireAdmin();
  const { data, error } = await supabaseAdmin.storage.from(REVIEW_BUCKET).download(path);
  if (error || !data) throw new ReviewStoreError(`Could not read audio: ${error?.message ?? "no data"}`, "download_failed");
  return new Uint8Array(await data.arrayBuffer());
}

// ── Rows ───────────────────────────────────────────────────────────────────

export async function insertReviewTurn(
  input: NewReviewTurn,
  nowMs: number = Date.now(),
  retentionDays: number = reviewRetentionDays()
): Promise<ReviewTurnRow> {
  requireAdmin();
  const { data, error } = await supabaseAdmin
    .from(REVIEW_TABLE)
    .insert({
      id: input.id,
      user_id: input.userId,
      surface: input.surface,
      mode: input.mode,
      source_lang: input.sourceLang,
      target_lang: input.targetLang,
      original_text: input.originalText,
      translation_text: input.translationText,
      segments: input.segments,
      audio_path: input.audioPath,
      audio_mime: input.audioMime,
      audio_bytes: input.audioBytes,
      rec_ms: input.recMs,
      transcribe_model: input.transcribeModel,
      translate_model: input.translateModel,
      timings: input.timings,
      created_at: new Date(nowMs).toISOString(),
      expires_at: reviewExpiresAt(nowMs, retentionDays).toISOString()
    })
    .select("*")
    .single();
  if (error || !data) {
    throw new ReviewStoreError(`Could not save the turn: ${error?.message ?? "no row"}`, "insert_failed");
  }
  return data as ReviewTurnRow;
}

export interface ReviewListFilter {
  /** ISO instants; both optional. */
  fromIso?: string | null;
  toIso?: string | null;
  /** The speaker's user id. */
  speakerId?: string | null;
  /** Only flagged turns. */
  flaggedOnly?: boolean;
  /** Only turns with no second opinion yet (opinion_at null). */
  unreviewedOnly?: boolean;
  /**
   * "suspects": lowest opinion_score first, unreviewed last, newest first
   * within a tie — lib/review/opinion.ts sortSuspectsFirst, in SQL.
   * Anything else: newest first.
   */
  sort?: "newest" | "suspects";
}

/** Unexpired turns, newest first (or suspects first), at most `limit`. */
export async function listReviewTurns(
  filter: ReviewListFilter = {},
  nowMs: number = Date.now(),
  limit: number = REVIEW_LIST_LIMIT
): Promise<ReviewTurnRow[]> {
  requireAdmin();
  let query = supabaseAdmin
    .from(REVIEW_TABLE)
    .select("*")
    .gt("expires_at", new Date(nowMs).toISOString());
  if (filter.fromIso) query = query.gte("created_at", filter.fromIso);
  if (filter.toIso) query = query.lt("created_at", filter.toIso);
  if (filter.speakerId) query = query.eq("user_id", filter.speakerId);
  if (filter.flaggedOnly) query = query.not("flag_reason", "is", null);
  if (filter.unreviewedOnly) query = query.is("opinion_at", null);
  if (filter.sort === "suspects") query = query.order("opinion_score", { ascending: true, nullsFirst: false });
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) throw new ReviewStoreError(`Could not list turns: ${error.message}`, "list_failed");
  return (data ?? []) as ReviewTurnRow[];
}

/** One unexpired turn by id, or null. */
export async function readReviewTurn(id: string, nowMs: number = Date.now()): Promise<ReviewTurnRow | null> {
  requireAdmin();
  const { data, error } = await supabaseAdmin
    .from(REVIEW_TABLE)
    .select("*")
    .eq("id", id)
    .gt("expires_at", new Date(nowMs).toISOString())
    .maybeSingle();
  if (error) throw new ReviewStoreError(`Could not read the turn: ${error.message}`, "read_failed");
  return (data as ReviewTurnRow | null) ?? null;
}

/**
 * Write the second opinion on a turn. Only the three opinion columns: this
 * path cannot touch flag_reason, flag_note or anything a person wrote.
 */
export async function saveReviewOpinion(
  id: string,
  opinion: ReviewOpinion,
  score: number | null,
  nowMs: number = Date.now()
): Promise<ReviewTurnRow | null> {
  requireAdmin();
  const { data, error } = await supabaseAdmin
    .from(REVIEW_TABLE)
    .update({ opinion, opinion_score: score, opinion_at: new Date(nowMs).toISOString() })
    .eq("id", id)
    .gt("expires_at", new Date(nowMs).toISOString())
    .select("*")
    .maybeSingle();
  if (error) throw new ReviewStoreError(`Could not save the opinion: ${error.message}`, "opinion_failed");
  return (data as ReviewTurnRow | null) ?? null;
}

/** Set (or clear, with `reason` null) the one flag a turn carries. */
export async function flagReviewTurn(
  id: string,
  reason: FlagReason | null,
  note: string,
  flaggedBy: string,
  nowMs: number = Date.now()
): Promise<ReviewTurnRow | null> {
  requireAdmin();
  const patch = reason
    ? { flag_reason: reason, flag_note: note, flagged_at: new Date(nowMs).toISOString(), flagged_by: flaggedBy }
    : { flag_reason: null, flag_note: "", flagged_at: null, flagged_by: null };
  const { data, error } = await supabaseAdmin
    .from(REVIEW_TABLE)
    .update(patch)
    .eq("id", id)
    .gt("expires_at", new Date(nowMs).toISOString())
    .select("*")
    .maybeSingle();
  if (error) throw new ReviewStoreError(`Could not save the flag: ${error.message}`, "flag_failed");
  return (data as ReviewTurnRow | null) ?? null;
}

export interface ReviewSpeaker {
  id: string;
  email: string;
}

/**
 * The founders who have a profile — the only people whose turns can be in
 * this table — so the page can label and filter rows by who spoke.
 */
export async function listReviewSpeakers(): Promise<ReviewSpeaker[]> {
  requireAdmin();
  const emails = [...founderEmails(process.env.NEXT_PUBLIC_FOUNDER_EMAILS)];
  const { data, error } = await supabaseAdmin.from("profiles").select("id, email").in("email", emails);
  if (error) throw new ReviewStoreError(`Could not list speakers: ${error.message}`, "speakers_failed");
  return ((data ?? []) as Array<{ id: string; email: string | null }>)
    .filter((r) => typeof r.email === "string")
    .map((r) => ({ id: r.id, email: r.email as string }));
}

// ── The sweep ──────────────────────────────────────────────────────────────

export interface ReviewSweepResult {
  scanned: number;
  objectsRemoved: number;
  rowsDeleted: number;
  error: string | null;
}

/**
 * Delete everything past its expires_at: objects first, rows second.
 * Bounded per call; the cron runs daily and a backlog drains over a few runs.
 */
export async function sweepReviewTurns(nowMs: number = Date.now(), batch = 500): Promise<ReviewSweepResult> {
  const result: ReviewSweepResult = { scanned: 0, objectsRemoved: 0, rowsDeleted: 0, error: null };
  if (!hasServiceRoleKey) {
    result.error = "no_service_role";
    return result;
  }
  const { data, error } = await supabaseAdmin
    .from(REVIEW_TABLE)
    .select("id, audio_path")
    .lte("expires_at", new Date(nowMs).toISOString())
    .limit(batch);
  if (error) {
    result.error = `list_${error.code ?? "failed"}`;
    return result;
  }
  const rows = (data ?? []) as Array<{ id: string; audio_path: string | null }>;
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const paths = rows.map((r) => r.audio_path).filter((p): p is string => Boolean(p));
  if (paths.length > 0) {
    const { data: removed, error: rmErr } = await supabaseAdmin.storage.from(REVIEW_BUCKET).remove(paths);
    if (rmErr) {
      // Keep the rows: a row whose audio still exists is findable; audio
      // whose row is gone is an orphan nobody can see.
      result.error = "storage_remove_failed";
      return result;
    }
    result.objectsRemoved = removed?.length ?? 0;
  }
  const { error: delErr } = await supabaseAdmin
    .from(REVIEW_TABLE)
    .delete()
    .in(
      "id",
      rows.map((r) => r.id)
    );
  if (delErr) {
    result.error = `delete_${delErr.code ?? "failed"}`;
    return result;
  }
  result.rowsDeleted = rows.length;
  return result;
}
