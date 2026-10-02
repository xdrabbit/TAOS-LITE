// Turning a flat history into conversations, for the Study picker.
//
// Rows written since 20261001_translation_sessions carry a session_id and
// group by it — that is the truth, written at the moment of speaking. Rows
// from before are grouped the only way they can be: by the same ten-minute
// gap the client uses, measured from the last turn. That is a reconstruction,
// and it is kept visibly separate (a `gap:` key, `reconstructed: true`) so a
// screen can say so rather than pass a guess off as a fact.
//
// Pure and client-safe: no imports beyond the session constant.

import { SESSION_GAP_MS } from "@/lib/translate/session";

/** The fields of a history row this module reads. */
export interface StudyTurn {
  id: string;
  created_at: string;
  session_id: string | null;
  source_lang: string;
  target_lang: string;
  original_text: string;
  translation_text: string;
}

export interface Conversation {
  /** The session_id, or `gap:<first row id>` for a reconstructed group. */
  key: string;
  reconstructed: boolean;
  startedAt: number;
  endedAt: number;
  /** Oldest first, so the conversation reads forwards. */
  turns: StudyTurn[];
}

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Group turns into conversations. Newest conversation first; turns oldest
 * first within each. Rows with a session_id never mix with rows without one.
 */
export function groupConversations(rows: StudyTurn[], gapMs: number = SESSION_GAP_MS): Conversation[] {
  const byId = new Map<string, StudyTurn[]>();
  const loose: StudyTurn[] = [];
  for (const row of rows) {
    if (row.session_id) {
      const list = byId.get(row.session_id) ?? [];
      list.push(row);
      byId.set(row.session_id, list);
    } else {
      loose.push(row);
    }
  }

  const out: Conversation[] = [];
  for (const [key, turns] of byId) {
    turns.sort((a, b) => ms(a.created_at) - ms(b.created_at));
    out.push({
      key,
      reconstructed: false,
      startedAt: ms(turns[0].created_at),
      endedAt: ms(turns[turns.length - 1].created_at),
      turns
    });
  }

  // Reconstruct the rest by gap, oldest first so the gap is from the last turn.
  loose.sort((a, b) => ms(a.created_at) - ms(b.created_at));
  let current: Conversation | null = null;
  for (const row of loose) {
    const at = ms(row.created_at);
    if (current && at - current.endedAt <= gapMs) {
      current.turns.push(row);
      current.endedAt = at;
    } else {
      current = { key: `gap:${row.id}`, reconstructed: true, startedAt: at, endedAt: at, turns: [row] };
      out.push(current);
    }
  }

  return out.sort((a, b) => b.endedAt - a.endedAt);
}

/** The side of a turn in `lang`, or null when the turn has no such side. */
export function sideIn(turn: StudyTurn, lang: string): string | null {
  if (turn.source_lang === lang) return turn.original_text;
  if (turn.target_lang === lang) return turn.translation_text;
  return null;
}

/** A one-line title for a conversation: its first turn, in the language being learned if it has one. */
export function conversationTitle(c: Conversation, lang: string): string {
  const first = c.turns[0];
  if (!first) return "";
  return (sideIn(first, lang) ?? first.original_text).trim();
}
