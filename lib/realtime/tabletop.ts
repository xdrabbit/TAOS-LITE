import type { RawRealtimeEvent } from "./types";

export const TABLETOP_ENGLISH = "en" as const;
export const TABLETOP_SPANISH = "es" as const;
export const TABLETOP_BACKLOG_THRESHOLD = 15;
export const TABLETOP_CLASSIFIER_WORD_STEP = 3;
export const TABLETOP_CATCH_UP_WINDOW_WORDS = 16;

export type TabletopLanguage = typeof TABLETOP_ENGLISH | typeof TABLETOP_SPANISH;
export type SpeakerSide = "speaker1_en" | "speaker2_es";
export type PaneId = "upper" | "lower";
export type FreshnessMode = "normal" | "catch_up";

const SPANISH_MARKERS = new Set([
  "el",
  "la",
  "los",
  "las",
  "de",
  "del",
  "que",
  "quiero",
  "puedo",
  "gracias",
  "hola",
  "estoy",
  "para",
  "con",
  "una",
  "uno",
  "sí",
  "tambien",
  "también"
]);

const ENGLISH_MARKERS = new Set([
  "the",
  "and",
  "with",
  "for",
  "this",
  "that",
  "hello",
  "thanks",
  "please",
  "want",
  "need",
  "can",
  "could",
  "would",
  "is",
  "are"
]);

function normalizeLanguageHint(value: string): TabletopLanguage | null {
  const lower = value.trim().toLowerCase();
  if (lower === "en" || lower.startsWith("en-") || lower.includes("english")) {
    return TABLETOP_ENGLISH;
  }

  if (lower === "es" || lower.startsWith("es-") || lower.includes("spanish")) {
    return TABLETOP_SPANISH;
  }

  return null;
}

function collectLanguageHints(
  value: unknown,
  depth: number,
  hints: string[],
  visited: Set<unknown>
): void {
  if (depth > 3 || !value || visited.has(value)) {
    return;
  }

  if (typeof value === "string") {
    hints.push(value);
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLanguageHints(item, depth + 1, hints, visited);
    }
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (/lang|language|locale/i.test(key) && typeof nested === "string") {
      hints.push(nested);
      continue;
    }

    if (typeof nested === "object") {
      collectLanguageHints(nested, depth + 1, hints, visited);
    }
  }
}

export function estimateWordCount(text: string): number {
  const matches = text.trim().match(/\b[\p{L}\p{N}'-]+\b/gu);
  return matches?.length ?? 0;
}

export function collapseFreshChunk(text: string, maxWords = TABLETOP_CATCH_UP_WINDOW_WORDS): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(" ");
  }

  return words.slice(-maxWords).join(" ");
}

export function inferLanguageFromEvent(
  event: RawRealtimeEvent,
  text: string,
  fallback: TabletopLanguage
): TabletopLanguage {
  const hints: string[] = [];
  collectLanguageHints(event, 0, hints, new Set());

  for (const hint of hints) {
    const normalized = normalizeLanguageHint(hint);
    if (normalized) {
      return normalized;
    }
  }

  return inferLanguageFromText(text, fallback);
}

export function inferLanguageFromText(text: string, fallback: TabletopLanguage): TabletopLanguage {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/[¿¡ñ]/i.test(text) || /(?:\b(?:gracias|hola|buenos|buenas|pero|porque|quiero)\b)/i.test(text)) {
    return TABLETOP_SPANISH;
  }

  const words = normalized.match(/\b[a-z']+\b/g) ?? [];
  let spanishScore = 0;
  let englishScore = 0;

  for (const word of words) {
    if (SPANISH_MARKERS.has(word)) {
      spanishScore += 2;
    }

    if (ENGLISH_MARKERS.has(word)) {
      englishScore += 2;
    }

    if (word.endsWith("cion") || word.endsWith("mente")) {
      spanishScore += 1;
    }

    if (word.endsWith("ing") || word.endsWith("tion")) {
      englishScore += 1;
    }
  }

  if (spanishScore === englishScore) {
    return fallback;
  }

  return spanishScore > englishScore ? TABLETOP_SPANISH : TABLETOP_ENGLISH;
}

export function inferSpeakerSide(language: TabletopLanguage): SpeakerSide {
  return language === TABLETOP_ENGLISH ? "speaker1_en" : "speaker2_es";
}

export function getRouting(language: TabletopLanguage): {
  pane: PaneId;
  speakerSide: SpeakerSide;
  targetLanguage: TabletopLanguage;
} {
  if (language === TABLETOP_ENGLISH) {
    return {
      pane: "lower",
      speakerSide: "speaker1_en",
      targetLanguage: TABLETOP_SPANISH
    };
  }

  return {
    pane: "upper",
    speakerSide: "speaker2_es",
    targetLanguage: TABLETOP_ENGLISH
  };
}
