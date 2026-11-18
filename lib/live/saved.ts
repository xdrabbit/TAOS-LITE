// "Save this conversation" on /live — the parts both sides of the wire share.
//
// Text only, off by default, and nothing is written unless the toggle is on at
// the moment a line is produced. The server half is lib/live/savedStore.ts
// (service role, after the auth and audience checks in lib/live/saveAccess.ts);
// the schema is supabase/migrations/20261117_live_saved_conversations.sql.
//
// Pure and dependency-free: the shell, the routes and the tests import this.

import type { LiveLine } from "@/lib/live/auto";
import type { LiveStyle } from "@/lib/live/style";

/** Per device. Off unless this device turned it on. */
export const LIVE_SAVE_STORAGE_KEY = "taos.live.save";

// Storage lives here, not in components/LiveShell.tsx — tests/release.test.ts
// forbids the shell from touching storage (see lib/live/style.ts).
export function readStoredLiveSave(): boolean {
  try {
    return window.localStorage.getItem(LIVE_SAVE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeLiveSave(on: boolean): void {
  try {
    window.localStorage.setItem(LIVE_SAVE_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* the choice still holds for this visit */
  }
}

/** What GET /api/live/saved/status answers. */
export interface LiveSaveStatus {
  /** Is this user in the audience TAOS_LIVE_SAVE names? False → no toggle. */
  allowed: boolean;
  /** Are the tables there? False → the toggle is shown disabled, with a hint. */
  ready: boolean;
  /**
   * Does this user already have a saved conversation? True → the link to
   * /live/saved is drawn even when `allowed` is false: reading, exporting and
   * deleting one's own never depended on being allowed to save more.
   */
  hasSaved: boolean;
}

export const LIVE_SAVE_UNAVAILABLE: LiveSaveStatus = { allowed: false, ready: false, hasSaved: false };

/** The longest heard text or rendering one saved line may carry. */
export const LIVE_SAVE_MAX_TEXT = 8000;

/** What the phone POSTs for one line: the session it belongs to, and the line. */
export interface LiveSaveRequest {
  session: {
    /** Made on the phone, once per START, at the first saved line. */
    id: string;
    mine: string;
    theirs: string;
    style: LiveStyle;
    auto: boolean;
    startedAt: string;
  };
  line: LiveLine;
}

export interface SavedLiveSession {
  id: string;
  lang_mine: string;
  lang_theirs: string;
  style: LiveStyle;
  auto: boolean;
  started_at: string;
  ended_at: string;
  /** Present on the list. */
  line_count?: number;
}

export interface SavedLiveLine {
  seq: number;
  heard_text: string;
  heard_lang: string | null;
  translation: string;
  translation_lang: string | null;
  detect: "hit" | "miss" | null;
  created_at: string;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A saved conversation as plain text — the export. Every line carries both
 * halves and the language each is in; a line whose language was not detected
 * says `??` rather than a guess.
 *
 *   TAOS·LITE — /live
 *   2026-11-17T20:12:00.000Z → 2026-11-17T20:15:10.000Z
 *   en ⇄ es · word for word · auto-detect
 *
 *   1.
 *   [es] ¿Dónde está el baño?
 *   [en] Where is the bathroom?
 *
 * `total` is how many lines the conversation has. When that is more than the
 * lines handed in, the file says so twice — under the heading and again at the
 * end, where a reader who scrolled to the bottom will find it. An export never
 * passes a part off as the whole.
 */
export function savedConversationAsText(
  session: SavedLiveSession,
  lines: readonly SavedLiveLine[],
  labelFor: (code: string) => string = (c) => c,
  total: number = lines.length
): string {
  const partial =
    total > lines.length ? `INCOMPLETE: this file holds the first ${lines.length} of ${total} lines.` : null;
  const tag = (code: string | null) => `[${code ? labelFor(code) : "??"}]`;
  const head = [
    "TAOS·LITE — /live",
    `${session.started_at} → ${session.ended_at}`,
    [
      `${labelFor(session.lang_mine)} ${session.auto ? "⇄" : "←"} ${labelFor(session.lang_theirs)}`,
      session.style === "verbatim" ? "word for word" : "summary",
      ...(session.auto ? ["auto-detect"] : [])
    ].join(" · "),
    ...(partial ? [partial] : [])
  ];
  const body = [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((l) =>
      [
        `${l.seq}.${l.detect === "miss" ? " (language not detected)" : ""}`,
        ...(l.heard_text ? [`${tag(l.heard_lang)} ${l.heard_text}`] : []),
        `${tag(l.translation_lang)} ${l.translation}`
      ].join("\n")
    );
  return [head.join("\n"), ...body, ...(partial ? [partial] : [])].join("\n\n") + "\n";
}
