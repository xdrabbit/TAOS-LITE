"use client";

import { useEffect, useState } from "react";
import {
  canSpeak,
  languageFlag,
  languageNative,
  searchLanguages,
  type Language,
  type LanguageCode
} from "@/lib/languages/catalog";
import { TEXT_ONLY_TITLE } from "@/lib/tts/speech";
import { TextOnlyChip } from "./TextOnly";

// The language picker — the pill row and the search sheet behind it.
//
// This lived inside TranslatorShell until 8/18, when /live, /tabletop and
// /chat were told to reach the same hundred languages. Four screens copying a
// pill row is four screens drifting apart: the "text only" mark on one of
// them, the search-by-native-name on another, and a stranger handed the phone
// learning the control twice. So the DRAWING lives here, once.
//
// What does NOT live here is the RULE. /translate and /live both hold a pair
// (lib/translate/pair.ts) and tap it the same way; /chat holds a single
// language of its own, out of a database row, and cannot touch its partner's.
// So this file takes a `selected` and a `paired` and draws them — the state
// that decides what those mean stays with the screen (or, for the pair
// screens, in lib/translate/useLanguagePair.ts).

// Shared pill chrome — the picker row and the "+ More" toggle are the same
// control at different jobs, so the classes live in one place.
export const PILL_CLASS =
  "rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition active:scale-95";
export const PILL_SELECTED_CLASS = "border-amber-300 bg-amber-400 text-stone-950"; // the output
export const PILL_MINE_CLASS = "border-amber-300 bg-transparent text-amber-200"; // your side
export const PILL_IDLE_CLASS = "border-amber-300/30 bg-amber-400/10 text-amber-200";

/** The sheet's default header — what tapping a language means on /translate. */
export const DEFAULT_PICKER_CAPTION = "Translate into · Traducir a";

interface PickerCommon {
  /** The solid pill: the language this screen is currently pointed at. */
  selected: LanguageCode;
  /**
   * The other language in play, drawn as an outline. On the pair screens this
   * is your own side and tapping it flips the pair; on /chat it is the
   * partner's language and it is not yours to change.
   */
  paired?: LanguageCode | null;
  /** Badge for `paired` in the sheet. "Yours" on the pair screens. */
  pairedLabel?: string;
  /**
   * What tapping `paired` does, for its tooltip and screen-reader name. The
   * pair screens flip; /chat's outlined pill is the PARTNER's language and a
   * tap moves your own side onto it, so "tap to flip" would be a lie there.
   */
  pairedTitle?: string;
  onSelect: (code: LanguageCode) => void;
}

// "Text only" — a tier-2 language, translated but never spoken (see the tier
// note in lib/languages/catalog.ts). On a pill it is a muted speaker and
// nothing more, because that is all the room there is; the sheet spells it out
// and each screen repeats it where its Play button would have been
// (components/TextOnly.tsx). Without it, the first turn in a text-only
// language looks like broken audio instead of a known limit.
export function LanguagePill({
  code,
  selected,
  paired,
  pairedTitle = "tap to flip",
  onSelect
}: PickerCommon & { code: LanguageCode }): JSX.Element {
  const isSelected = code === selected;
  const isPaired = code === paired;
  const textOnly = !canSpeak(code);
  const name = languageNative(code);
  const pairedNote = isPaired ? ` — ${pairedTitle}` : "";
  return (
    <button
      type="button"
      onClick={() => onSelect(code)}
      aria-pressed={isSelected}
      title={`${name}${pairedNote}${textOnly ? ` · ${TEXT_ONLY_TITLE}` : ""}`}
      aria-label={`${name}${pairedNote}${textOnly ? ` — ${TEXT_ONLY_TITLE}` : ""}`}
      className={`${PILL_CLASS} ${
        isSelected ? PILL_SELECTED_CLASS : isPaired ? PILL_MINE_CLASS : PILL_IDLE_CLASS
      }`}
    >
      {languageFlag(code)} {code.toUpperCase()}
      {textOnly ? <span className="ml-1 opacity-60">🔇</span> : null}
    </button>
  );
}

// ── The language sheet ─────────────────────────────────────────────────────
// Everything the pill row can't hold, which after 8/17 is most of a hundred
// languages. A search box and a list is the only shape that stays two taps
// deep at that size — the old "Other · Otros" disclosure worked at six and
// would be a scroll at a hundred.
//
// It is a SHEET, not a screen: it sits over whatever screen opened it, and
// choosing a language drops you straight back onto the conversation with that
// language selected. Nobody navigates anywhere.
export function LanguageSheet({
  open,
  selected,
  paired,
  pairedLabel = "Yours",
  caption = DEFAULT_PICKER_CAPTION,
  onSelect,
  onClose
}: PickerCommon & {
  open: boolean;
  caption?: string;
  onClose: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState("");

  // A fresh search every time it opens. Reopening onto the last person's
  // half-typed query would hide the list behind three stale letters.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const results: readonly Language[] = searchLanguages(query);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-black/70"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Choose a language · Elegir idioma"
    >
      <div
        // Stop taps inside the sheet from reaching the backdrop's close.
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] flex-col gap-3 rounded-t-3xl border-t border-amber-300/20 bg-[rgba(28,23,19,0.98)] p-4 pb-6"
      >
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.2em] text-amber-100/40">{caption}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close · Cerrar"
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70"
          >
            Close · Cerrar
          </button>
        </div>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Opens the keyboard on the way in: the list is a hundred long, so
          // typing is the fast path and scrolling is the fallback.
          autoFocus
          placeholder="Search · Buscar…"
          aria-label="Search languages · Buscar idiomas"
          className="w-full rounded-2xl border border-amber-300/20 bg-black/30 px-4 py-3 text-base text-white placeholder:text-amber-100/30 focus:border-amber-300/50 focus:outline-none"
        />

        <ul className="flex-1 overflow-y-auto">
          {results.length === 0 ? (
            <li className="px-2 py-6 text-center text-sm text-amber-100/40">
              No language matches · Ningún idioma coincide
            </li>
          ) : (
            results.map((language) => {
              const isSelected = language.code === selected;
              const isPaired = language.code === paired;
              return (
                <li key={language.code}>
                  <button
                    type="button"
                    onClick={() => onSelect(language.code)}
                    aria-pressed={isSelected}
                    className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition active:scale-[0.99] ${
                      isSelected ? "bg-amber-400/20" : "hover:bg-white/5"
                    }`}
                  >
                    <span className="text-xl">{language.flag}</span>
                    <span className="min-w-0 flex-1">
                      {/* The language's OWN name leads: the person who speaks
                          it is often the one being handed the phone. */}
                      <span className="block truncate text-base text-white">{language.native}</span>
                      <span className="block truncate text-xs text-amber-100/40">
                        {language.label} · {language.labelEs}
                      </span>
                    </span>
                    {language.tts ? null : <TextOnlyChip />}
                    {isSelected ? (
                      <span className="shrink-0 text-amber-300">✓</span>
                    ) : isPaired ? (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-100/40">
                        {pairedLabel}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}

/**
 * The row itself: the working set of pills plus the "+ More · Más" that opens
 * the sheet. Every screen draws this the same way, which is the whole point —
 * the row keeps its width no matter how big the catalog gets, which was Tom's
 * constraint on 8/15 and is the only reason the catalog could grow.
 */
export function LanguagePillRow({
  pills,
  selected,
  paired,
  pairedTitle,
  caption,
  sheetOpen,
  onSelect,
  onOpenSheet
}: PickerCommon & {
  pills: readonly LanguageCode[];
  /** Omitted on the cramped rows (/tabletop's table bar) — the row alone. */
  caption?: string;
  sheetOpen: boolean;
  onOpenSheet: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {caption ? (
        <div className="text-[10px] uppercase tracking-[0.2em] text-amber-100/40">{caption}</div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {pills.map((code) => (
          <LanguagePill
            key={code}
            code={code}
            selected={selected}
            paired={paired}
            pairedTitle={pairedTitle}
            onSelect={onSelect}
          />
        ))}
        <button
          type="button"
          onClick={onOpenSheet}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          aria-label="More languages · Más idiomas"
          title="More languages · Más idiomas"
          className={`${PILL_CLASS} ${PILL_IDLE_CLASS}`}
        >
          + More · Más
        </button>
      </div>
    </div>
  );
}
