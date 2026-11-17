// Where a saved /live conversation lives. Server-only: every WRITE to the two
// tables goes through here with the service role, after the route has checked
// who is asking (lib/live/saveAccess.ts). The tables' own RLS lets a signed-in
// user select and delete their own rows and nothing else
// (supabase/migrations/20261117_live_saved_conversations.sql); these functions
// filter on user_id as well, so the service role never reads across users.
//
// ── The tables may not be there ────────────────────────────────────────────
// The migration is applied by hand, after the code ships. Until then
// liveSaveTablesReady() is false, the phone's toggle is disabled with a hint,
// and the write route answers `not_ready` without touching anything.
//
// ── Nothing here logs ──────────────────────────────────────────────────────
// The routes log ids and counts. The text of a conversation is never put in a
// log line, an error message or a thrown Error by this file.

import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";
import { resolveLiveStyle } from "@/lib/live/style";
import {
  LIVE_SAVE_MAX_TEXT,
  UUID_RE,
  type LiveSaveRequest,
  type SavedLiveLine,
  type SavedLiveSession
} from "@/lib/live/saved";

export const LIVE_SESSIONS_TABLE = "taos_lite_live_sessions";
export const LIVE_LINES_TABLE = "taos_lite_live_lines";
/** How many saved conversations the list loads. */
export const LIVE_SAVED_LIST_LIMIT = 200;
/** How many lines one conversation is read (and exported) with. */
export const LIVE_SAVED_LINES_LIMIT = 5000;

export class LiveSavedError extends Error {
  constructor(public readonly code: string) {
    // The code is the whole message on purpose: a Supabase error string can
    // quote the row it choked on.
    super(code);
    this.name = "LiveSavedError";
  }
}

// ── Are the tables there? ──────────────────────────────────────────────────

let readyUntil = 0;
let notReadyUntil = 0;

/** Forget what the probe last saw. For tests. */
export function resetLiveSaveReadiness(): void {
  readyUntil = 0;
  notReadyUntil = 0;
}

/**
 * One cheap read of each table. A yes is remembered for five minutes per
 * instance and a no for thirty seconds, so the phone that asks right after
 * Tom applies the migration is not told "not yet" for long.
 */
export async function liveSaveTablesReady(now: number = Date.now()): Promise<boolean> {
  if (!hasServiceRoleKey) return false;
  if (now < readyUntil) return true;
  if (now < notReadyUntil) return false;
  try {
    const [sessions, lines] = await Promise.all([
      supabaseAdmin.from(LIVE_SESSIONS_TABLE).select("id").limit(1),
      supabaseAdmin.from(LIVE_LINES_TABLE).select("id").limit(1)
    ]);
    if (sessions.error || lines.error) {
      notReadyUntil = now + 30_000;
      return false;
    }
    readyUntil = now + 5 * 60_000;
    return true;
  } catch {
    notReadyUntil = now + 30_000;
    return false;
  }
}

// ── Writing one line ───────────────────────────────────────────────────────

function langOrNull(v: unknown): string | null {
  return typeof v === "string" && isSupportedLanguageCode(v) ? v : null;
}

function clip(v: unknown): string {
  return typeof v === "string" ? v.slice(0, LIVE_SAVE_MAX_TEXT) : "";
}

/** A request body, checked. null = not something this route stores. */
export function parseLiveSaveRequest(body: unknown): LiveSaveRequest | null {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const s = (b.session && typeof b.session === "object" ? b.session : {}) as Record<string, unknown>;
  const l = (b.line && typeof b.line === "object" ? b.line : {}) as Record<string, unknown>;
  const mine = langOrNull(s.mine);
  const theirs = langOrNull(s.theirs);
  if (typeof s.id !== "string" || !UUID_RE.test(s.id) || !mine || !theirs) return null;
  const seq = typeof l.seq === "number" && Number.isInteger(l.seq) && l.seq >= 0 && l.seq < 1e6 ? l.seq : null;
  const text = clip(l.text).trim();
  if (seq === null || !text) return null;
  const started = typeof s.startedAt === "string" ? Date.parse(s.startedAt) : NaN;
  const detect = l.detect === "hit" || l.detect === "miss" ? l.detect : null;
  return {
    session: {
      id: s.id.toLowerCase(),
      mine,
      theirs,
      style: resolveLiveStyle(s.style),
      auto: s.auto === true,
      startedAt: new Date(Number.isFinite(started) ? started : Date.now()).toISOString()
    },
    line: {
      seq,
      heard: clip(l.heard).trim(),
      // A miss stores no language, whatever the body claimed.
      heardLang: detect === "miss" ? null : langOrNull(l.heardLang),
      text,
      textLang: detect === "miss" ? null : langOrNull(l.textLang),
      detect
    }
  };
}

/**
 * Store one line, creating its session with the first one. Idempotent: the
 * same (session, seq) twice is one row.
 *
 * The session id is made on the phone, so it is not trusted: the insert never
 * overwrites an existing row, and the line is only written after an UPDATE
 * that matches both the id and this user has touched exactly that session.
 * Somebody else's id → `not_yours`, nothing written.
 */
export async function saveLiveLine(userId: string, req: LiveSaveRequest, now: number = Date.now()): Promise<void> {
  if (!hasServiceRoleKey) throw new LiveSavedError("no_service_role");
  const nowIso = new Date(now).toISOString();

  const created = await supabaseAdmin.from(LIVE_SESSIONS_TABLE).upsert(
    {
      id: req.session.id,
      user_id: userId,
      lang_mine: req.session.mine,
      lang_theirs: req.session.theirs,
      style: req.session.style,
      auto: req.session.auto,
      started_at: req.session.startedAt,
      ended_at: nowIso
    },
    { onConflict: "id", ignoreDuplicates: true }
  );
  if (created.error) throw new LiveSavedError("session_write_failed");

  const owned = await supabaseAdmin
    .from(LIVE_SESSIONS_TABLE)
    .update({ ended_at: nowIso })
    .eq("id", req.session.id)
    .eq("user_id", userId)
    .select("id");
  if (owned.error) throw new LiveSavedError("session_write_failed");
  if (!owned.data || owned.data.length !== 1) throw new LiveSavedError("not_yours");

  const line = await supabaseAdmin.from(LIVE_LINES_TABLE).upsert(
    {
      session_id: req.session.id,
      user_id: userId,
      seq: req.line.seq,
      heard_text: req.line.heard,
      heard_lang: req.line.heardLang,
      translation: req.line.text,
      translation_lang: req.line.textLang,
      detect: req.line.detect
    },
    { onConflict: "session_id,seq", ignoreDuplicates: true }
  );
  if (line.error) throw new LiveSavedError("line_write_failed");
}

// ── Reading, and deleting ──────────────────────────────────────────────────

const SESSION_COLUMNS = "id, lang_mine, lang_theirs, style, auto, started_at, ended_at";

/** This user's saved conversations, newest first, each with its line count. */
export async function listSavedLive(userId: string): Promise<SavedLiveSession[]> {
  if (!hasServiceRoleKey) throw new LiveSavedError("no_service_role");
  const { data, error } = await supabaseAdmin
    .from(LIVE_SESSIONS_TABLE)
    .select(`${SESSION_COLUMNS}, ${LIVE_LINES_TABLE}(count)`)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(LIVE_SAVED_LIST_LIMIT);
  if (error) throw new LiveSavedError("list_failed");
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => {
    const { [LIVE_LINES_TABLE]: counted, ...session } = row;
    const first = Array.isArray(counted) ? (counted[0] as { count?: number } | undefined) : undefined;
    return { ...(session as unknown as SavedLiveSession), line_count: first?.count ?? 0 };
  });
}

/** One conversation and its lines in order, or null if it is not this user's. */
export async function readSavedLive(
  userId: string,
  sessionId: string
): Promise<{ session: SavedLiveSession; lines: SavedLiveLine[] } | null> {
  if (!hasServiceRoleKey) throw new LiveSavedError("no_service_role");
  const found = await supabaseAdmin
    .from(LIVE_SESSIONS_TABLE)
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (found.error) throw new LiveSavedError("read_failed");
  if (!found.data) return null;
  const lines = await supabaseAdmin
    .from(LIVE_LINES_TABLE)
    .select("seq, heard_text, heard_lang, translation, translation_lang, detect, created_at")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .order("seq", { ascending: true })
    .limit(LIVE_SAVED_LINES_LIMIT);
  if (lines.error) throw new LiveSavedError("read_failed");
  return {
    session: found.data as unknown as SavedLiveSession,
    lines: (lines.data ?? []) as unknown as SavedLiveLine[]
  };
}

/** Delete one conversation (its lines go with it). False = it was not this user's. */
export async function deleteSavedLive(userId: string, sessionId: string): Promise<boolean> {
  if (!hasServiceRoleKey) throw new LiveSavedError("no_service_role");
  const { data, error } = await supabaseAdmin
    .from(LIVE_SESSIONS_TABLE)
    .delete()
    .eq("id", sessionId)
    .eq("user_id", userId)
    .select("id");
  if (error) throw new LiveSavedError("delete_failed");
  return Array.isArray(data) && data.length > 0;
}
