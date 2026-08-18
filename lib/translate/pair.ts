// The language-pill rule for /translate, kept pure so tests can fence it
// (tests/translate-pair.test.ts) — the same reason buildInstructions and
// elevenLabsVoiceId live outside their routes.
//
// A conversation is a PAIR written [yours, theirs]. "Theirs" is the output:
// the language the pill row shows as selected, and the one a translation comes
// out in. One tap has to cover both things people do at a table — change who
// they are talking to, and change which side of the pair they are on — without
// a second control:
//
//   tap a language already the output -> nothing (it is already selected)
//   tap YOUR OWN side                 -> the pair flips, so you become the one
//                                        being translated into. This is how one
//                                        row of pills gives Tom EN⇄IT and Liz
//                                        ES⇄IT from the same four languages.
//   tap anything else                 -> it becomes the output; your side stays
//
// The pair is what /api/translate scopes auto-detect to, which is why the rule
// never produces a pair of one repeated language: two identical sides would
// ask the model to pick between a language and itself.
export function nextPair<T extends string>(
  pair: readonly [T, T],
  tapped: T
): readonly [T, T] {
  const [mine, theirs] = pair;
  // Returning the SAME reference (not a copy) lets the caller skip the state
  // churn — clearing the on-screen turn for a tap that changed nothing would
  // wipe a translation someone is still reading.
  if (tapped === theirs) return pair;
  if (tapped === mine) return [theirs, mine];
  return [mine, tapped];
}

// ── The pair as shared state ───────────────────────────────────────────────
// The pair started life inside TranslatorShell, but it is not /translate's
// private business: it is the answer to "what languages is this phone's owner
// working between right now?", and the photo translator needs the same answer
// (8/17 — a menu in Mostar should come back in the language its reader picked
// on the pills, not in whatever the auto rule guesses). Type, storage key, and
// the read/write pair live here so there is ONE definition of the pair on
// disk; the pills, flags, and copy stay in the shell that draws them.

export type PairLangCode = "en" | "es" | "bs" | "it" | "zh" | "yue";

// Every language the pair can hold — the pill row plus the "Other · Otros"
// guests. Adding a language here is not enough on its own: it also needs a
// flag and speaker copy in TranslatorShell.
export const PAIR_LANGUAGES: readonly PairLangCode[] = ["en", "es", "bs", "it", "zh", "yue"];

const PAIR_LANGUAGE_SET = new Set<string>(PAIR_LANGUAGES);

export function isPairLangCode(value: unknown): value is PairLangCode {
  return typeof value === "string" && PAIR_LANGUAGE_SET.has(value);
}

export const PAIR_STORAGE_KEY = "taos.translate.languages";

// [yours, theirs]. Spanish first because /translate's `source` still defaults
// to "es" (Liz speaks first, as it has always been) — so a fresh install reads
// "translate into English", which is the direction the app took before pills.
export const DEFAULT_PAIR: readonly [PairLangCode, PairLangCode] = ["es", "en"];

// Anything can be in localStorage — an old format, half a write, a value some
// other tab wrote. A pair only survives if it is two DIFFERENT supported
// languages (the doubled-side rule from nextPair above); everything else
// reads as "nothing saved" so the caller falls back to its own default.
export function parseStoredPair(raw: string | null): readonly [PairLangCode, PairLangCode] | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as unknown;
    if (!Array.isArray(stored) || stored.length !== 2) return null;
    const [a, b] = stored;
    if (!isPairLangCode(a) || !isPairLangCode(b) || a === b) return null;
    return [a, b];
  } catch {
    return null;
  }
}

// Browser-only helpers. localStorage throws in Safari private browsing and is
// absent during SSR, so both sides swallow — a phone that cannot persist just
// starts from the defaults every time.
export function readStoredPair(): readonly [PairLangCode, PairLangCode] | null {
  try {
    return parseStoredPair(window.localStorage.getItem(PAIR_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeStoredPair(pair: readonly [PairLangCode, PairLangCode]): void {
  try {
    window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(pair));
  } catch {
    /* private mode — the choice just won't survive a reload */
  }
}
