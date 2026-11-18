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
/**
 * How many saved conversations ONE PAGE of the list holds. It bounds a page,
 * not the history: the list is walked with `offset` until `more` is false.
 */
export const LIVE_SAVED_LIST_PAGE = 50;
/**
 * How many lines are asked for per request when a conversation is read.
 *
 * This is not a preference. The project's PostgREST answers at most 1,000
 * rows per request whatever `.limit()` says — measured 2026-11-17 against
 * production with the service role: `limit=5000` on a 12,392-row table came
 * back 206 with `Content-Range: 0-999/12392` and no error. The first version
 * of this file asked for 5,000 in one go and would have shown, and exported,
 * the first 1,000 lines of a long conversation as if they were all of it.
 * So a conversation is read in pages, and the read does not trust the page
 * size either: it stops on the row count the database reports.
 */
export const LIVE_SAVED_LINES_PAGE = 1000;
/**
 * The most lines one read returns. Far beyond anything a session can produce
 * (a START is capped at two hours); it exists so a request has an end. A
 * conversation longer than this is NOT cut quietly: the read says
 * `complete: false` with the real total, and the reader and the export both
 * say so in words.
 */
export const LIVE_SAVED_LINES_MAX = 20_000;

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

/** One page of the list, and whether there is anything older than it. */
export interface SavedLivePage {
  sessions: SavedLiveSession[];
  /** True → ask again with `offset + sessions.length`. */
  more: boolean;
}

/** A page offset from a query string. Anything that is not a whole number ≥ 0 is 0. */
export function parseSavedOffset(raw: string | null | undefined): number {
  const n = typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(n) ? n : 0;
}

/**
 * This user's saved conversations, newest first, each with its line count —
 * one page of them, from `offset`. One row more than a page is asked for, and
 * that extra row is only ever the answer to "is there more?".
 */
export async function listSavedLive(userId: string, offset: number = 0): Promise<SavedLivePage> {
  if (!hasServiceRoleKey) throw new LiveSavedError("no_service_role");
  const { data, error } = await supabaseAdmin
    .from(LIVE_SESSIONS_TABLE)
    .select(`${SESSION_COLUMNS}, ${LIVE_LINES_TABLE}(count)`)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    // Two conversations can share a started_at; without a tiebreak a row could
    // sit on both sides of a page boundary, or on neither.
    .order("id", { ascending: false })
    .range(offset, offset + LIVE_SAVED_LIST_PAGE);
  // PostgREST answers a range that starts past the last row with a 416
  // (PGRST103), not with no rows. That is the end of the list, not a failure:
  // it is what "Show older" meets when the last conversations were deleted
  // from another phone in the meantime.
  if (error && offset > 0 && (error as { code?: string }).code === "PGRST103") return { sessions: [], more: false };
  if (error) throw new LiveSavedError("list_failed");
  const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => {
    const { [LIVE_LINES_TABLE]: counted, ...session } = row;
    const first = Array.isArray(counted) ? (counted[0] as { count?: number } | undefined) : undefined;
    return { ...(session as unknown as SavedLiveSession), line_count: first?.count ?? 0 };
  });
  return { sessions: rows.slice(0, LIVE_SAVED_LIST_PAGE), more: rows.length > LIVE_SAVED_LIST_PAGE };
}

/**
 * Does this user have anything saved? Asked for the link on /live, which must
 * be there for someone who can no longer save but still has text to read or
 * delete. A failed lookup is "no": it decides a link, nothing else.
 */
export async function hasSavedLive(userId: string): Promise<boolean> {
  if (!hasServiceRoleKey) return false;
  try {
    const { data, error } = await supabaseAdmin.from(LIVE_SESSIONS_TABLE).select("id").eq("user_id", userId).limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** One conversation as it was read. */
export interface SavedLiveRead {
  session: SavedLiveSession;
  lines: SavedLiveLine[];
  /** How many lines the conversation HAS, as the database counts them. */
  total: number;
  /** False → `lines` stops at LIVE_SAVED_LINES_MAX and `total` is larger. */
  complete: boolean;
}

/**
 * One conversation and its lines in order, or null if it is not this user's.
 *
 * Read in pages (see LIVE_SAVED_LINES_PAGE) until the count the database
 * reported has arrived. A page that comes back short is not taken as the end —
 * that is exactly how a row cap looks — only an empty one is. Anything other
 * than "all of it" or "the first LIVE_SAVED_LINES_MAX, said so" is an error:
 * this function never hands back a partial conversation as a whole one.
 */
export async function readSavedLive(userId: string, sessionId: string): Promise<SavedLiveRead | null> {
  if (!hasServiceRoleKey) throw new LiveSavedError("no_service_role");
  const found = await supabaseAdmin
    .from(LIVE_SESSIONS_TABLE)
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (found.error) throw new LiveSavedError("read_failed");
  if (!found.data) return null;

  const lines: SavedLiveLine[] = [];
  let total = 0;
  while (lines.length < LIVE_SAVED_LINES_MAX) {
    const from = lines.length;
    const to = Math.min(from + LIVE_SAVED_LINES_PAGE, LIVE_SAVED_LINES_MAX) - 1;
    const page = await supabaseAdmin
      .from(LIVE_LINES_TABLE)
      .select("seq, heard_text, heard_lang, translation, translation_lang, detect, created_at", { count: "exact" })
      .eq("session_id", sessionId)
      .eq("user_id", userId)
      .order("seq", { ascending: true })
      .range(from, to);
    if (page.error || typeof page.count !== "number") throw new LiveSavedError("read_failed");
    total = page.count;
    const rows = (page.data ?? []) as unknown as SavedLiveLine[];
    lines.push(...rows);
    if (rows.length === 0 || lines.length >= total) break;
  }
  const complete = lines.length >= total;
  // Short of the total without having reached the ceiling: the pages stopped
  // coming. Say so rather than pass it off as the conversation.
  if (!complete && lines.length < LIVE_SAVED_LINES_MAX) throw new LiveSavedError("read_incomplete");
  return { session: found.data as unknown as SavedLiveSession, lines, total, complete };
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
