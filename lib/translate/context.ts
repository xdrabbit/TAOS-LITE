// Conversation context for a home turn (/api/translate) — disambiguation only.
//
// Each recording used to be translated alone, so a short turn whose meaning
// depends on what was just said was a coin flip: "Pero es seguro" after three
// turns about insurance came back "but it's safe" (seguro = insurance). Tom,
// 10/28: send the last few turns as context, translate only the new one.
//
// The client sends the last CONTEXT_MAX_TURNS exchanges it already holds in
// memory for the current conversation (lib/translate/session.ts decides what
// "current" means) — never anything fetched from history. The server parses
// the field strictly and drops it whole on anything unexpected, then the
// prompt builders in lib/translate/prompts.ts fence it as read-only.
//
// Request-only, by design: the context is never logged and never saved.
// Earlier turns already live in the history table as their own rows; a second
// copy riding along on every row would be the same words stored twice.
//
// Pure, and outside the component and the route, so tests can fence every
// half of it without a server or a phone.

import { isSupportedLanguageCode } from "@/lib/realtime/languages";
import { SESSION_GAP_MS, type ConversationSession } from "@/lib/translate/session";

export const CONTEXT_MAX_TURNS = 3;
export const CONTEXT_MAX_CHARS = 400;
// A ceiling on the raw form field before JSON.parse ever sees it: three turns
// of two 400-char strings plus keys and escapes fit comfortably inside this.
export const CONTEXT_MAX_FIELD_CHARS = 8000;

export interface ContextTurn {
  source_lang: string;
  target_lang: string;
  original: string;
  translation: string;
}

/** Cut to CONTEXT_MAX_CHARS UTF-16 units without leaving half an emoji behind. */
export function clipContextText(text: string): string {
  if (text.length <= CONTEXT_MAX_CHARS) return text;
  let cut = text.slice(0, CONTEXT_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** The last CONTEXT_MAX_TURNS turns, oldest first, every string clipped. */
export function selectContext(turns: readonly ContextTurn[]): ContextTurn[] {
  return turns.slice(-CONTEXT_MAX_TURNS).map((t) => ({
    source_lang: t.source_lang,
    target_lang: t.target_lang,
    original: clipContextText(t.original),
    translation: clipContextText(t.translation)
  }));
}

// ── Client side ─────────────────────────────────────────────────────────────

/** What the home screen remembers: completed turns of ONE conversation. */
export interface ContextStore {
  sessionId: string | null;
  turns: ContextTurn[];
}

export const EMPTY_CONTEXT: ContextStore = { sessionId: null, turns: [] };

/**
 * The turns to send with the next request. Only turns from the conversation
 * still in progress count: once the session has gone quiet for longer than
 * SESSION_GAP_MS, the next turn starts a new conversation and gets none.
 */
export function contextForNextTurn(
  store: ContextStore,
  session: ConversationSession | null,
  now: number
): ContextTurn[] {
  if (!session || store.sessionId !== session.id) return [];
  if (now - session.lastTurnAt > SESSION_GAP_MS) return [];
  return selectContext(store.turns);
}

/**
 * Remember a completed turn. A new session id starts the memory over. A turn
 * with a blank side is not remembered — the server would refuse the whole
 * field over it, and it has nothing to disambiguate with anyway.
 */
export function rememberTurn(
  store: ContextStore,
  sessionId: string,
  turn: ContextTurn
): ContextStore {
  const prior = store.sessionId === sessionId ? store.turns : [];
  if (turn.original.trim() === "" || turn.translation.trim() === "") {
    return { sessionId, turns: prior };
  }
  return { sessionId, turns: selectContext([...prior, turn]) };
}

// ── Server side ─────────────────────────────────────────────────────────────

function isContextTurn(value: unknown): value is ContextTurn {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.source_lang === "string" &&
    typeof t.target_lang === "string" &&
    isSupportedLanguageCode(t.source_lang) &&
    isSupportedLanguageCode(t.target_lang) &&
    typeof t.original === "string" &&
    typeof t.translation === "string" &&
    t.original.trim() !== "" &&
    t.translation.trim() !== "" &&
    t.original.length <= CONTEXT_MAX_CHARS &&
    t.translation.length <= CONTEXT_MAX_CHARS
  );
}

/**
 * The `context` form field, or null. All or nothing: more than
 * CONTEXT_MAX_TURNS items, a string over CONTEXT_MAX_CHARS, an unsupported
 * language code, or anything that isn't the shape above, and the whole field
 * is ignored — the turn translates exactly as it did before context existed.
 */
export function parseContextField(raw: FormDataEntryValue | null): ContextTurn[] | null {
  if (typeof raw !== "string" || raw === "" || raw.length > CONTEXT_MAX_FIELD_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > CONTEXT_MAX_TURNS) {
    return null;
  }
  if (!parsed.every(isContextTurn)) return null;
  return parsed.map((t) => ({
    source_lang: t.source_lang,
    target_lang: t.target_lang,
    original: t.original,
    translation: t.translation
  }));
}
