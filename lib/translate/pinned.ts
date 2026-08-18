// Which languages get a pill, and which one falls off when a new one arrives.
//
// The pill row is the one control that is always on screen, and it is the
// reason /translate has been rationed to a handful of languages: pairs grow as
// the square of the languages, pills grow one per language, and a row that
// grows at all eventually wraps into a wall. The row was folded down once
// already (8/15, EN⇄ES + "Other") for exactly this.
//
// So the row stops being the catalog and becomes a WORKING SET: the pair you
// are in right now, plus the languages you have reached for lately, capped at
// MAX_PILLS. Everything else is one tap away behind the search sheet. Adding a
// language to the catalog no longer widens anything on screen.
//
// ── Why the row does not reorder itself ─────────────────────────────────
// Recency decides WHO IS ON the row. It deliberately does not decide the
// ORDER — that is the catalog's own order, always. A most-recent-first row
// would reshuffle under someone's thumb between two turns of a live
// conversation, which is how you tap Italian and get Bosnian in a restaurant.
// Positions here only move when a language actually joins or leaves.
import { SHEET_LANGUAGES } from "@/lib/languages/catalog";
import { isPairLangCode, type PairLangCode } from "./pair";

/**
 * The most LANGUAGE pills that can be on screen at once.
 *
 * Four, not five, because the "+ More · Más" button sits on the same row and
 * counts against the same width: five controls total, which is exactly what
 * the row held before this change (the trip four plus "Other · Otros") and
 * exactly what fits on one line on the narrowest phone either of them carries.
 * The row is `flex-wrap` — a sixth control does not overflow, it silently
 * becomes a second line, which is the thing this whole design exists to
 * prevent. If a wider row is ever wanted, this constant is the only edit.
 */
export const MAX_PILLS = 4;

/**
 * Recency is remembered deeper than it is shown, so a language pushed off the
 * row by a couple of taps is still there when the pair moves and a slot opens
 * — without having to go back through the sheet for it.
 */
export const RECENT_LIMIT = 12;

export const RECENT_STORAGE_KEY = "taos.translate.recent";

/**
 * A phone that has never picked a language starts on the trip row that was
 * hard-coded before this file existed (Tom, 8/17: Bosnia + Italy), so opening
 * the app after this change looks like the app did before it.
 */
export const DEFAULT_RECENT: readonly PairLangCode[] = ["en", "es", "bs", "it"];

const CATALOG_ORDER = new Map<string, number>(SHEET_LANGUAGES.map((l, i) => [l.code, i]));

function catalogIndex(code: string): number {
  return CATALOG_ORDER.get(code) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * The pills to draw, in the order to draw them.
 *
 * The pair's two languages are always among them — they are the conversation
 * in progress, and a pill row that could not show the language you are
 * currently speaking into would be lying about the state of the app. Recents
 * fill whatever room is left, and the result is sorted into catalog order so
 * the row stays put between taps.
 */
export function visiblePills(
  pair: readonly [PairLangCode, PairLangCode],
  recent: readonly PairLangCode[]
): readonly PairLangCode[] {
  const picked: PairLangCode[] = [];
  // Pair first — this is a priority for INCLUSION, not the display order.
  for (const code of [pair[0], pair[1], ...recent]) {
    if (picked.length >= MAX_PILLS) break;
    if (!picked.includes(code)) picked.push(code);
  }
  return picked.sort((a, b) => catalogIndex(a) - catalogIndex(b));
}

/**
 * Note that a language was just used. Newest first — this list is the answer
 * to "what falls off the row next", nothing more.
 */
export function rememberLanguage(
  recent: readonly PairLangCode[],
  code: PairLangCode
): readonly PairLangCode[] {
  return [code, ...recent.filter((c) => c !== code)].slice(0, RECENT_LIMIT);
}

/**
 * Anything can be in localStorage — an old format, half a write, a code from a
 * build that spelled things differently. Unknown codes are dropped rather than
 * failing the whole list: one bad entry should cost one pill, not the row.
 */
export function parseStoredRecent(raw: string | null): readonly PairLangCode[] | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as unknown;
    if (!Array.isArray(stored)) return null;
    const codes: PairLangCode[] = [];
    for (const value of stored) {
      if (isPairLangCode(value) && !codes.includes(value)) codes.push(value);
    }
    return codes.length ? codes.slice(0, RECENT_LIMIT) : null;
  } catch {
    return null;
  }
}

// Browser-only, and silent on failure for the same reason as the pair's
// helpers: localStorage throws in Safari private browsing and is absent during
// SSR, and a phone that cannot persist should still work — it just starts from
// the trip row every time.
export function readStoredRecent(): readonly PairLangCode[] {
  try {
    return parseStoredRecent(window.localStorage.getItem(RECENT_STORAGE_KEY)) ?? DEFAULT_RECENT;
  } catch {
    return DEFAULT_RECENT;
  }
}

export function writeStoredRecent(recent: readonly PairLangCode[]): void {
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recent));
  } catch {
    /* private mode — the row just won't survive a reload */
  }
}
