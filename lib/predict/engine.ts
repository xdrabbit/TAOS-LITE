// ── Client-side prediction engine (zero-latency, in-memory) ──────────────────
// Runs on EVERY keystroke with no network call. Given a loaded model and the
// current input value, it blends three tiers of the same n-gram model:
//   tier 1  mid-word    → word completion (prefix match on unigrams)
//   tier 2  after space → next-word (trigram → bigram → unigram backoff)
//   tier 3  phrase      → thought completion (a recurring phrase continues)
// Returns one ghost suggestion (top pick) + up to 4 chip alternatives.

import type { PredictModel } from "./model.mjs";

export interface Suggestion {
  /** Human-readable label for a chip. */
  label: string;
  /** The full new input value if this suggestion is accepted. */
  apply: string;
}

export interface Prediction {
  /** Dimmed text rendered inline after the caret ("" = nothing to show). */
  ghostText: string;
  /** New input value if the ghost is accepted (Tab / →), or null. */
  ghostApply: string | null;
  /** Up to 4 tappable alternatives (thumb-friendly). */
  chips: Suggestion[];
}

const EMPTY: Prediction = { ghostText: "", ghostApply: null, chips: [] };
const MAX_CHIPS = 4;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/** Tokens of the text, lowercased, punctuation stripped. */
function tokens(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) || []) as string[];
}

/** Scan unigrams for words starting with `prefix` (excluding an exact match). */
function prefixWords(model: PredictModel, prefix: string, limit: number): string[] {
  const out: Array<[string, number]> = [];
  for (const word in model.unigrams) {
    if (word.length > prefix.length && word.startsWith(prefix)) {
      out.push([word, model.unigrams[word]]);
    }
  }
  out.sort((a, b) => b[1] - a[1]);
  return out.slice(0, limit).map(([w]) => w);
}

/** Rank next-word candidates by trigram → bigram backoff (context-aware). */
function nextWords(model: PredictModel, prev2: string | null, prev1: string | null): string[] {
  const seen = new Set<string>();
  const ranked: string[] = [];
  const push = (pairs?: Array<[string, number]>) => {
    if (!pairs) return;
    for (const [w] of pairs) {
      if (!seen.has(w)) {
        seen.add(w);
        ranked.push(w);
      }
    }
  };
  if (prev2 && prev1) push(model.trigrams[`${prev2} ${prev1}`]);
  if (prev1) push(model.bigrams[prev1]);
  return ranked;
}

// Replace the trailing partial word with `full`; keep everything before it.
function completeWord(input: string, full: string): string {
  return input.replace(/[\p{L}\p{N}'’-]+$/u, full);
}

// Append a next word after the (space-terminated) input.
function appendWord(input: string, word: string): string {
  return `${input}${word} `;
}

/**
 * Find a recurring phrase whose start matches the tail the user is typing, and
 * return the REMAINING words as a completion. e.g. typed "te juro que" and a
 * known phrase "te juro que te amo" → suggests "te amo".
 */
function phraseCompletion(
  model: PredictModel,
  toks: string[],
  atWordBoundary: boolean
): { label: string; rest: string } | null {
  if (toks.length === 0) return null;
  // Match against the last up-to-5 typed tokens (longest tail first = most specific).
  for (let take = Math.min(5, toks.length); take >= 1; take -= 1) {
    const tail = toks.slice(toks.length - take).join(" ");
    for (const [text] of model.phrases) {
      const words = text.split(" ");
      if (words.length <= take) continue;
      const head = words.slice(0, take).join(" ");
      // At a word boundary we need an exact tail match; mid-word the last typed
      // token may be a partial of the phrase's matching word.
      const matches = atWordBoundary
        ? head === tail
        : head.startsWith(tail) && head !== tail;
      if (matches) {
        const rest = atWordBoundary
          ? words.slice(take).join(" ")
          : words.slice(take - 1).join(" "); // include the word being completed
        if (rest) return { label: rest, rest };
      }
    }
  }
  return null;
}

export function predict(model: PredictModel | null, input: string): Prediction {
  if (!model || !input) return EMPTY;

  const toks = tokens(input);
  const atBoundary = /\s$/.test(input) || input.length === 0;
  const prev1 = toks.length >= 1 ? toks[toks.length - 1] : null;
  const prev2 = toks.length >= 2 ? toks[toks.length - 2] : null;

  const chips: Suggestion[] = [];
  const pushChip = (label: string, apply: string) => {
    if (chips.length >= MAX_CHIPS) return;
    if (apply === input) return;
    if (chips.some((c) => c.apply === apply)) return;
    chips.push({ label, apply });
  };

  let ghostText = "";
  let ghostApply: string | null = null;

  if (!atBoundary && prev1) {
    // ── Tier 1: mid-word completion (context-aware ranking) ────────────────
    const partial = prev1;
    const ctxPrev1 = toks.length >= 2 ? toks[toks.length - 2] : null;
    const ctxPrev2 = toks.length >= 3 ? toks[toks.length - 3] : null;
    // Prefer completions the user habitually types AFTER the previous word.
    const contextRanked = nextWords(model, ctxPrev2, ctxPrev1).filter(
      (w) => w.length > partial.length && w.startsWith(partial)
    );
    const globalRanked = prefixWords(model, partial, 8);
    const ordered: string[] = [];
    for (const w of [...contextRanked, ...globalRanked]) {
      if (!ordered.includes(w)) ordered.push(w);
    }
    if (ordered.length > 0) {
      const top = ordered[0];
      ghostText = top.slice(partial.length);
      ghostApply = completeWord(input, top);
      for (const w of ordered) pushChip(w, completeWord(input, w));
    }
    // A phrase whose current word is still being typed can jump ahead.
    const ph = phraseCompletion(model, toks, false);
    if (ph) pushChip(ph.label, completeWord(input, ph.rest));
  } else {
    // ── Tier 2: next-word after a space ────────────────────────────────────
    let ordered = nextWords(model, prev2, prev1);
    if (ordered.length === 0) {
      // Backoff: cold start / unknown context → most habitual words overall.
      ordered = Object.entries(model.unigrams)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([w]) => w);
    }
    if (ordered.length > 0) {
      const top = ordered[0];
      ghostText = top; // rendered right after the space-terminated input
      ghostApply = appendWord(input, top);
      for (const w of ordered) pushChip(w, appendWord(input, w));
    }
    // ── Tier 3: thought completion — surface a recurring phrase as a chip ──
    const ph = phraseCompletion(model, toks, true);
    if (ph) {
      const apply = `${input}${ph.rest} `;
      // If it's a strong, longer continuation and no next-word ghost yet, ghost it.
      if (!ghostApply) {
        ghostText = ph.rest;
        ghostApply = apply;
      }
      pushChip(ph.label, apply);
    }
  }

  return { ghostText, ghostApply, chips: chips.slice(0, MAX_CHIPS) };
}
