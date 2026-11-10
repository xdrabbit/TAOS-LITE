// The interpreter's STYLE (Tom, 2026-11-09, after the first table test):
//
//   interpreter   what the mode has been from the start — faithful, and
//                 silent otherwise. THE DEFAULT.
//   mediator      EXPERIMENTAL, off unless a founder turns it on for their
//                 device. "Not just an interpreter but a third party at the
//                 table": it still interprets everything, but may *briefly*
//                 speak up, in both languages, ONLY when meaning is at risk —
//                 a likely misunderstanding, a regional word with two
//                 meanings, a pronoun it cannot resolve — and it answers a
//                 question put to it directly ("mediator, what did she
//                 mean?").
//
// Where the idea came from: at that table GPT-Live rendered "I'm pissed off"
// as "Estoy arrecha" — angry in Venezuela and Colombia, aroused in Mexico and
// Central America. An interpreter cannot say so. A mediator can.
//
// This file is the style's vocabulary and the reading of what a mediator
// said; the PROMPT is in lib/interpreter/briefing.ts. Isomorphic and pure.
//
// ── How a note is told apart from an interpretation ────────────────────────
// The model speaks; what reaches the captions is the transcript of its voice.
// There is no side channel that works on every engine, so the mark is SPOKEN:
// every note begins with a fixed phrase in the language it is given in
// ("Mediator note: …" / "Nota del mediador: …"). The people at the table hear
// that it is the mediator and not the other person talking, and the captions
// split on the same words. The phrase comes from the chrome copy table, so a
// language somebody adds there gets its own; every other language uses the
// English one.

import { copyFor } from "@/lib/chrome/copy";

export type InterpreterStyle = "interpreter" | "mediator";

export const INTERPRETER_STYLES: readonly InterpreterStyle[] = ["interpreter", "mediator"];

/** OFF by default: nothing but an explicit choice makes a mediator. */
export const DEFAULT_INTERPRETER_STYLE: InterpreterStyle = "interpreter";

/** Per-device founder choice, beside the engine's. */
export const STYLE_STORAGE_KEY = "taos.interpreter.style";

export function parseStyle(raw: unknown): InterpreterStyle | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (INTERPRETER_STYLES as readonly string[]).includes(v) ? (v as InterpreterStyle) : null;
}

/** Anything that is not exactly "mediator" — unset, a typo — is the interpreter. */
export function resolveStyle(stored: unknown): InterpreterStyle {
  return parseStyle(stored) ?? DEFAULT_INTERPRETER_STYLE;
}

/** The words a mediator note begins with, in `lang` (English where unknown). */
export function mediatorMarker(lang: string): string {
  return copyFor(lang).interpreterMediatorNote;
}

// ── Reading a mediator's transcript ────────────────────────────────────────

export interface MediatorNote {
  /** The language of the marker it began with. */
  lang: string;
  text: string;
}

export interface MediatorSplit {
  /** What was interpreted — everything before the first note. */
  interpretation: string;
  notes: MediatorNote[];
}

/**
 * Lower-case and accent-free, ONE code unit per code unit — so an index into
 * the folded text is an index into the original.
 */
function fold(text: string): string {
  let out = "";
  for (const unit of text.normalize("NFC").split("")) {
    const base = unit.normalize("NFD")[0] ?? unit;
    const lower = base.toLowerCase();
    out += lower.length === 1 ? lower : base;
  }
  return out;
}

function markerPattern(marker: string): string {
  return fold(marker)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    // "Mediator's note" is the same mark as "Mediator note".
    .join("(?:['’]s)?[\\s\\u00a0]+");
}

/**
 * Split what a mediator said into the interpretation and its notes. `langs`
 * are the table's languages; text with no marker in it comes back whole, as
 * the interpretation, with no notes — which is every line an interpreter (as
 * opposed to a mediator) ever says.
 */
export function splitMediatorNotes(said: string, langs: readonly string[]): MediatorSplit {
  const text = said.normalize("NFC");
  if (!text.trim()) return { interpretation: text, notes: [] };

  // Longest marker first, so "Nota del mediador" is never read as a shorter one.
  const markers = [...new Set(langs)]
    .map((lang) => ({ lang, pattern: markerPattern(mediatorMarker(lang)) }))
    .filter((m) => m.pattern)
    .sort((a, b) => b.pattern.length - a.pattern.length);
  if (!markers.length) return { interpretation: text, notes: [] };

  const folded = fold(text);
  const hits: { at: number; end: number; lang: string }[] = [];
  for (const { lang, pattern } of markers) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])[\\s:,.;—–-]*`, "gu");
    for (const m of folded.matchAll(re)) {
      const at = m.index ?? 0;
      // Two languages may share a marker (the English fallback): first wins.
      if (hits.some((h) => at < h.end && at + m[0].length > h.at)) continue;
      hits.push({ at, end: at + m[0].length, lang });
    }
  }
  if (!hits.length) return { interpretation: text, notes: [] };
  hits.sort((a, b) => a.at - b.at);

  const tidy = (s: string) => s.replace(/^[\s:,.;—–-]+/u, "").trim();
  const notes: MediatorNote[] = [];
  hits.forEach((hit, i) => {
    const body = tidy(text.slice(hit.end, hits[i + 1]?.at ?? text.length));
    if (body) notes.push({ lang: hit.lang, text: body });
  });
  return { interpretation: text.slice(0, hits[0].at).trim(), notes };
}
