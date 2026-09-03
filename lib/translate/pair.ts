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
//
// ── When the flip is wrong (9/3) ────────────────────────────────────
// The flip is a good rule at a table, where the pair is yours alone and one
// tap undoes it. It is the WRONG rule mid-call, where the pair is half of a
// handshake: Tom, on a call, saw his own outlined pill labelled "You hear
// this", tapped it wanting to hear that language, and the flip pointed the
// interpreter at the other one AND announced the change to his partner's
// phone, degrading both sides of a live conversation — then persisted it to
// localStorage so the next screen he opened was wrong too.
//
// So the flip is an OPTION, not a law. A caller that cannot afford it passes
// `flipOnOwnSide: false` and a tap on your own side becomes what tapping the
// selected pill already is: nothing at all, same reference back.
import { isLanguageCode, LANGUAGES, type LanguageCode } from "@/lib/languages/catalog";

export interface NextPairOptions {
  /**
   * Whether tapping your own side flips the pair. Default true — the table
   * rule. /call turns it off for the duration of a call (see above).
   */
  flipOnOwnSide?: boolean;
}

export function nextPair<T extends string>(
  pair: readonly [T, T],
  tapped: T,
  options: NextPairOptions = {}
): readonly [T, T] {
  const { flipOnOwnSide = true } = options;
  const [mine, theirs] = pair;
  // Returning the SAME reference (not a copy) lets the caller skip the state
  // churn — clearing the on-screen turn for a tap that changed nothing would
  // wipe a translation someone is still reading. A locked own-side tap takes
  // the same road, so it costs nothing and writes nothing.
  if (tapped === theirs) return pair;
  if (tapped === mine) return flipOnOwnSide ? [theirs, mine] : pair;
  return [mine, tapped];
}

// ── Which way round a turn runs ────────────────────────────────────────────
// The pair says WHICH two languages; these say which of them is the source
// and which the target for one particular turn. Every screen needs this and
// each of them used to answer it privately: /live with a DIRECTIONS table
// keyed by "es-en", /tabletop with an otherLang() that flipped between two
// hard-coded codes. Both are the same two lines, and both feed the streaming
// pipeline directly — which is exactly the sort of thing worth being able to
// unit-test without a phone in the loop.

/** Who is talking: the phone's owner, or the person they are talking with. */
export type PairSide = "mine" | "theirs";

export interface PairDirection {
  sourceLanguage: PairLangCode;
  targetLanguage: PairLangCode;
}

/**
 * Source and target for a turn, given who is speaking.
 *
 * Named to match the /api/tts and /api/live-translate request bodies so it
 * can be spread straight into them — the point is that no screen gets to
 * assemble these two fields by hand any more.
 */
export function pairDirection(
  pair: readonly [PairLangCode, PairLangCode],
  speaking: PairSide
): PairDirection {
  const [mine, theirs] = pair;
  return speaking === "theirs"
    ? { sourceLanguage: theirs, targetLanguage: mine }
    : { sourceLanguage: mine, targetLanguage: theirs };
}

/**
 * The OTHER side of the pair from `code` — who a turn spoken in `code` is
 * being translated for. A code that is not in the pair at all answers with
 * the pair's own second side, which is the only sane fallback: it keeps the
 * result inside the conversation rather than echoing an outsider's language
 * back at them.
 */
export function otherInPair(
  pair: readonly [PairLangCode, PairLangCode],
  code: PairLangCode
): PairLangCode {
  return code === pair[0] ? pair[1] : pair[0];
}

// ── The pair as shared state ───────────────────────────────────────────────
// The pair started life inside TranslatorShell, but it is not /translate's
// private business: it is the answer to "what languages is this phone's owner
// working between right now?", and the photo translator needs the same answer
// (8/17 — a menu in Mostar should come back in the language its reader picked
// on the pills, not in whatever the auto rule guesses). Type, storage key, and
// the read/write pair live here so there is ONE definition of the pair on
// disk; the pills, flags, and copy stay in the shell that draws them.

// The pair can hold ANY language in the catalog (8/17). It used to be a
// six-code union that had to be grown by hand alongside a flag and a block of
// speaker copy in TranslatorShell — which is exactly why it stayed at six
// while the pipeline could already handle a hundred. The catalog carries the
// flag and the native name now, and the shell falls back to English copy for
// a language it has no translation of, so a language reaches the pair the
// moment it reaches lib/languages/catalog.ts.
export type PairLangCode = LanguageCode;

export const PAIR_LANGUAGES: readonly PairLangCode[] = LANGUAGES.map((l) => l.code);

export function isPairLangCode(value: unknown): value is PairLangCode {
  return isLanguageCode(value);
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
