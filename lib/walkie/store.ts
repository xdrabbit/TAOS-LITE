// Where a Taokie message lives, and for how long. Server-only: the table has
// RLS enabled and NO policies, so the service role is the only reader and
// writer and these functions are the only door (the taos_leads /
// tutor_lessons pattern, supabase/migrations/20260826_leads_server_only.sql).
//
// ── Shape ──────────────────────────────────────────────────────────────────
// One row per turn, in public.taos_lite_walkie_messages: who sent it, into
// which room, in which two languages, the transcript, the translation, and
// two objects in the private `walkie-audio` bucket — the sender's recording
// and the spoken translation. Modelled on /chat's voice notes
// (lib/chatVoice.ts, taos_lite_chat_messages) rather than reusing them: a
// chat thread is two named members with a delete route and membership
// policies, where a walkie channel is a room code and a 30-day clock.
//
// ── Retention ──────────────────────────────────────────────────────────────
// `expires_at` is stamped at insert from TAOS_WALKIE_RETENTION_DAYS
// (lib/walkie/flag.ts). The sweep deletes the storage objects FIRST and the
// rows second — Postgres can never delete from storage.objects (memory:
// data-hygiene), so a row-only delete would strand the audio, which is
// exactly the orphan the chat sweep exists to chase. Run by Vercel Cron
// daily (vercel.json → GET /api/walkie/sweep with CRON_SECRET) and kicked,
// best-effort, from the message list.

import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { walkieExpiresAt, walkieRetentionDays } from "./flag";
import type { StoredTimings } from "./timing";

export const WALKIE_TABLE = "taos_lite_walkie_messages";
export const WALKIE_BUCKET = "walkie-audio";
export const WALKIE_HISTORY_TABLE = "taos_lite_translations";
/** The engine stamped on the home-history row a walkie turn also writes. */
export const WALKIE_HISTORY_ENGINE = "walkie";
/** How many messages the screen loads on entry. */
export const WALKIE_LIST_LIMIT = 50;
/** How long a signed audio link lives. Long enough to replay from the log. */
export const WALKIE_SIGNED_URL_SECONDS = 3600;

export function walkieExtensionFor(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "webm";
}

/**
 * `<room>/<id>.<kind>.<ext>` — room first, like /chat's thread-first paths,
 * so a room's audio is one folder and a sweep can reason about it.
 */
export function walkieAudioPath(room: string, id: string, kind: "rec" | "say", mime: string): string {
  return `${room}/${id}.${kind}.${walkieExtensionFor(mime)}`;
}

export interface WalkieMessageRow {
  id: string;
  room: string;
  sender_id: string;
  source_lang: string;
  target_lang: string;
  original_text: string;
  translation_text: string;
  audio_path: string | null;
  speech_path: string | null;
  speech_engine: string | null;
  rec_ms: number | null;
  timings: StoredTimings;
  released_at: string | null;
  created_at: string;
  expires_at: string;
  delivered_at: string | null;
  played_at: string | null;
}

export interface NewWalkieMessage {
  room: string;
  senderId: string;
  sourceLang: string;
  targetLang: string;
  originalText: string;
  translationText: string;
  audioPath: string | null;
  speechPath: string | null;
  speechEngine: string | null;
  recMs: number | null;
  timings: StoredTimings;
  releasedAt: Date | null;
}

export class WalkieStoreError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "WalkieStoreError";
  }
}

function requireAdmin(): void {
  if (!hasServiceRoleKey) {
    throw new WalkieStoreError("Server is missing SUPABASE_SERVICE_ROLE_KEY.", "no_service_role");
  }
}

export async function uploadWalkieAudio(path: string, bytes: ArrayBuffer | Uint8Array, mime: string): Promise<void> {
  requireAdmin();
  const { error } = await supabaseAdmin.storage
    .from(WALKIE_BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw new WalkieStoreError(`Could not store audio: ${error.message}`, "upload_failed");
}

export async function removeWalkieAudio(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  requireAdmin();
  await supabaseAdmin.storage.from(WALKIE_BUCKET).remove(paths);
}

export async function insertWalkieMessage(
  input: NewWalkieMessage,
  nowMs: number = Date.now(),
  retentionDays: number = walkieRetentionDays()
): Promise<WalkieMessageRow> {
  requireAdmin();
  const { data, error } = await supabaseAdmin
    .from(WALKIE_TABLE)
    .insert({
      room: input.room,
      sender_id: input.senderId,
      source_lang: input.sourceLang,
      target_lang: input.targetLang,
      original_text: input.originalText,
      translation_text: input.translationText,
      audio_path: input.audioPath,
      speech_path: input.speechPath,
      speech_engine: input.speechEngine,
      rec_ms: input.recMs,
      timings: input.timings,
      released_at: input.releasedAt ? input.releasedAt.toISOString() : null,
      created_at: new Date(nowMs).toISOString(),
      expires_at: walkieExpiresAt(nowMs, retentionDays).toISOString()
    })
    .select("*")
    .single();
  if (error || !data) {
    throw new WalkieStoreError(`Could not save the message: ${error?.message ?? "no row"}`, "insert_failed");
  }
  return data as WalkieMessageRow;
}

/**
 * The same turn, counted where the home screen counts its own: one row in
 * taos_lite_translations for the sender (Tom: "Taokie turns count like home
 * turns"). The monthly allowance is a count of rows in that table
 * (lib/supabase.ts getMonthlyUsage), so this is the whole of the metering.
 * Never throws — a turn that was spoken and delivered is not undone over a
 * bookkeeping row; the failure is logged.
 */
export async function countWalkieTurnAsHomeTurn(input: {
  senderId: string;
  sourceLang: string;
  targetLang: string;
  originalText: string;
  translationText: string;
}): Promise<boolean> {
  if (!hasServiceRoleKey) return false;
  const { error } = await supabaseAdmin.from(WALKIE_HISTORY_TABLE).insert({
    user_id: input.senderId,
    source_lang: input.sourceLang,
    target_lang: input.targetLang,
    tone: "detailed",
    original_text: input.originalText,
    translation_text: input.translationText,
    engine: WALKIE_HISTORY_ENGINE
  });
  if (error) {
    console.error(`[taos-walkie] history_row_failed code=${error.code ?? "?"}`);
    return false;
  }
  return true;
}

/**
 * Unexpired messages in a room, oldest first, at most WALKIE_LIST_LIMIT.
 * `afterIso` narrows to rows created after that instant — the on-air
 * catch-up poll asks for "anything since the last one I have".
 */
export async function listWalkieMessages(
  room: string,
  nowMs: number = Date.now(),
  limit: number = WALKIE_LIST_LIMIT,
  afterIso: string | null = null
): Promise<WalkieMessageRow[]> {
  requireAdmin();
  let query = supabaseAdmin
    .from(WALKIE_TABLE)
    .select("*")
    .eq("room", room)
    .gt("expires_at", new Date(nowMs).toISOString());
  if (afterIso) query = query.gt("created_at", afterIso);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) throw new WalkieStoreError(`Could not list messages: ${error.message}`, "list_failed");
  return ((data ?? []) as WalkieMessageRow[]).reverse();
}

export async function getWalkieMessage(id: string, nowMs: number = Date.now()): Promise<WalkieMessageRow | null> {
  requireAdmin();
  const { data, error } = await supabaseAdmin
    .from(WALKIE_TABLE)
    .select("*")
    .eq("id", id)
    .gt("expires_at", new Date(nowMs).toISOString())
    .maybeSingle();
  if (error) throw new WalkieStoreError(`Could not read the message: ${error.message}`, "read_failed");
  return (data as WalkieMessageRow | null) ?? null;
}

export async function signWalkieAudio(path: string | null): Promise<string | null> {
  if (!path) return null;
  requireAdmin();
  const { data, error } = await supabaseAdmin.storage
    .from(WALKIE_BUCKET)
    .createSignedUrl(path, WALKIE_SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** How many receipts one poll may ask for. */
export const WALKIE_RECEIPTS_LIMIT = 10;

export interface WalkieReceiptRow {
  id: string;
  delivered_at: string | null;
  played_at: string | null;
}

/**
 * The two receipt stamps for a handful of messages — what the SENDER's
 * phone re-reads when the partner's "got" / "played" broadcast may have been
 * lost (2026-11-02: the sender's own channel was rejoining). Ids only, no
 * text, no audio link.
 */
export async function getWalkieReceipts(ids: string[], nowMs: number = Date.now()): Promise<WalkieReceiptRow[]> {
  if (ids.length === 0) return [];
  requireAdmin();
  const { data, error } = await supabaseAdmin
    .from(WALKIE_TABLE)
    .select("id, delivered_at, played_at")
    .in("id", ids.slice(0, WALKIE_RECEIPTS_LIMIT))
    .gt("expires_at", new Date(nowMs).toISOString());
  if (error) throw new WalkieStoreError(`Could not read the receipts: ${error.message}`, "receipts_failed");
  return (data ?? []) as WalkieReceiptRow[];
}

export type WalkieAck = "delivered" | "played";

/** Stamp a receipt. Only the first of each kind sticks. */
export async function ackWalkieMessage(id: string, kind: WalkieAck, nowMs: number = Date.now()): Promise<WalkieMessageRow | null> {
  requireAdmin();
  const column = kind === "delivered" ? "delivered_at" : "played_at";
  const { data, error } = await supabaseAdmin
    .from(WALKIE_TABLE)
    .update({ [column]: new Date(nowMs).toISOString() })
    .eq("id", id)
    .is(column, null)
    .select("*")
    .maybeSingle();
  if (error) throw new WalkieStoreError(`Could not record the receipt: ${error.message}`, "ack_failed");
  return (data as WalkieMessageRow | null) ?? null;
}

export interface WalkieSweepResult {
  scanned: number;
  objectsRemoved: number;
  rowsDeleted: number;
  error: string | null;
}

/**
 * Delete everything past its expires_at: objects first, rows second.
 * Bounded per call; the cron runs daily and a backlog drains over a few runs.
 */
export async function sweepWalkieMessages(nowMs: number = Date.now(), batch = 500): Promise<WalkieSweepResult> {
  const result: WalkieSweepResult = { scanned: 0, objectsRemoved: 0, rowsDeleted: 0, error: null };
  if (!hasServiceRoleKey) {
    result.error = "no_service_role";
    return result;
  }
  const { data, error } = await supabaseAdmin
    .from(WALKIE_TABLE)
    .select("id, audio_path, speech_path")
    .lte("expires_at", new Date(nowMs).toISOString())
    .limit(batch);
  if (error) {
    result.error = `list_${error.code ?? "failed"}`;
    return result;
  }
  const rows = (data ?? []) as Array<{ id: string; audio_path: string | null; speech_path: string | null }>;
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const paths = rows.flatMap((r) => [r.audio_path, r.speech_path]).filter((p): p is string => Boolean(p));
  if (paths.length > 0) {
    const { data: removed, error: rmErr } = await supabaseAdmin.storage.from(WALKIE_BUCKET).remove(paths);
    if (rmErr) {
      // Keep the rows: a row whose audio still exists is findable; audio
      // whose row is gone is an orphan nobody can see.
      result.error = "storage_remove_failed";
      return result;
    }
    result.objectsRemoved = removed?.length ?? 0;
  }
  const { error: delErr } = await supabaseAdmin
    .from(WALKIE_TABLE)
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

// ── The one user setting ───────────────────────────────────────────────────
// "Show message text in notifications", default ON (Tom's decision #4).
// Stored on profiles — the user's row, written by the service role like every
// other profiles column (docs/data-map.md §8). Inert until push exists: no
// notification is sent anywhere today, so this is the setting and its
// storage, ready for the day one is.
export const WALKIE_NOTIFY_TEXT_COLUMN = "walkie_notify_text";

export async function readWalkieNotifyText(userId: string): Promise<boolean> {
  requireAdmin();
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select(WALKIE_NOTIFY_TEXT_COLUMN)
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new WalkieStoreError(`Could not read the setting: ${error.message}`, "settings_read_failed");
  const v = (data as Record<string, unknown> | null)?.[WALKIE_NOTIFY_TEXT_COLUMN];
  return typeof v === "boolean" ? v : true;
}

export async function writeWalkieNotifyText(userId: string, value: boolean): Promise<void> {
  requireAdmin();
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ [WALKIE_NOTIFY_TEXT_COLUMN]: value })
    .eq("id", userId);
  if (error) throw new WalkieStoreError(`Could not save the setting: ${error.message}`, "settings_write_failed");
}
