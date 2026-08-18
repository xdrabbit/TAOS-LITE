"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LanguageCode } from "@/lib/languages/catalog";
import {
  DEFAULT_PAIR,
  nextPair,
  readStoredPair,
  writeStoredPair,
  type PairLangCode
} from "./pair";
import {
  DEFAULT_RECENT,
  readStoredRecent,
  rememberLanguage,
  visiblePills,
  writeStoredRecent
} from "./pinned";

// The pair, the row, and the sheet as ONE piece of state — because three
// screens now hold it and they were never going to hold it identically.
//
// /translate had all of this inline. /live and /tabletop were hard-coded
// EN⇄ES. Copying the restore-from-localStorage effect and the recency
// bookkeeping into each of them is how you end up with a phone whose pair
// depends on which screen you opened first. The pair is ONE answer to "what
// languages is this phone working between right now?" (lib/translate/pair.ts
// says so), so it gets one reader and one writer.
//
// ── What the two sides mean ────────────────────────────────────────────────
// [mine, theirs]. `mine` is the phone owner; `theirs` is whoever is on the
// other side of the conversation. That is stable across the screens; what
// MOVES is which side the translation comes out in, because the screens do
// different jobs:
//
//   /translate — you speak, it comes out in THEIRS (you are talking to them)
//   /live      — they speak, it comes out in MINE (they are talking near you)
//   /tabletop  — both, turn by turn; each end hears the other's
//
// So a phone left on [en, it] after ordering dinner in Italian is already
// right for /live at that same table: no taps, and the summaries arrive in
// English. Getting this backwards would have made the persisted pair worse
// than useless on /live — the one screen where you are the listener.
//
// The pill highlighted solid is always THEIRS, on every screen: "the other
// language in play". Each screen captions its own row so nobody has to guess
// which direction that implies.

export interface LanguagePairSelection {
  pair: readonly [PairLangCode, PairLangCode];
  /** pair[0] — the phone owner's language. */
  mine: PairLangCode;
  /** pair[1] — the other side, and the solid pill. */
  theirs: PairLangCode;
  /** The working set to draw, catalog-ordered (lib/translate/pinned.ts). */
  pills: readonly PairLangCode[];
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  /** The tap rule: pick a language, or tap your own side to flip. */
  selectLanguage: (code: LanguageCode) => void;
}

export interface LanguagePairOptions {
  /**
   * Called whenever the pair actually changes — a pick, a flip, or the
   * restore at mount. NOT called for a tap that changed nothing (tapping the
   * language already selected), so a screen can safely tear down a turn in
   * here without wiping something someone is still reading.
   */
  onPairChange?: (pair: readonly [PairLangCode, PairLangCode]) => void;
}

export function useLanguagePair(options: LanguagePairOptions = {}): LanguagePairSelection {
  const { onPairChange } = options;
  const [pair, setPair] = useState<readonly [PairLangCode, PairLangCode]>(DEFAULT_PAIR);
  const [recent, setRecent] = useState<readonly PairLangCode[]>(DEFAULT_RECENT);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Keep the callback in a ref so the restore effect below stays a mount-only
  // effect: screens pass an inline arrow, and depending on it would re-run the
  // restore (and re-clear the screen) on every render.
  const changeRef = useRef(onPairChange);
  useEffect(() => {
    changeRef.current = onPairChange;
  }, [onPairChange]);

  // Restore the last languages used on this phone — Tom's is EN⇄IT while
  // Liz's is ES⇄IT, and neither should have to re-pick every time the app is
  // opened, on any screen.
  useEffect(() => {
    // The row is restored even when the pair isn't: a phone that has reached
    // for Italian and French should still show them, whatever pair it is
    // sitting in.
    setRecent(readStoredRecent());
    const stored = readStoredPair();
    if (!stored) return;
    setPair(stored);
    changeRef.current?.(stored);
  }, []);

  const selectLanguage = useCallback(
    (code: LanguageCode) => {
      // Remembered whatever the pair does with it. Tapping the language you
      // are already pointed at changes nothing about the conversation, but it
      // is still a USE — and the thing being used should be the last thing to
      // fall off the row.
      setRecent((current) => {
        const updated = rememberLanguage(current, code);
        writeStoredRecent(updated);
        return updated;
      });
      const updated = nextPair(pair, code);
      setSheetOpen(false);
      // nextPair returns the SAME reference for a no-op tap — that identity
      // check is the whole reason it does, so honour it here and leave the
      // screen exactly as it was.
      if (updated === pair) return;
      setPair(updated);
      writeStoredPair(updated);
      changeRef.current?.(updated);
    },
    [pair]
  );

  return {
    pair,
    mine: pair[0],
    theirs: pair[1],
    pills: visiblePills(pair, recent),
    sheetOpen,
    setSheetOpen,
    selectLanguage
  };
}
