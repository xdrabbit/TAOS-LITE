// Dialects and idioms for /dictate (Tom, 2026-11-27).
//
// Why: the same word means different things in different places. Venezuelan
// "arrecho" is angry; in Mexico it is aroused (lib/interpreter/mediator.ts has
// the table story). Liz writes Venezuelan Spanish, so a message from her must
// be READ as Venezuelan Spanish, and a dictation TO her must be written in
// words a Venezuelan reads the intended way.
//
// The caller sends `dialects`: one region per language, as CODES —
// { "es": "VE", "en": "US" }. The label that reaches the prompt comes from the
// table below, never from the request, so nothing typed by a caller is placed
// in a system prompt. An unknown language or region is ignored, never an error.
//
// Idioms are not tied to a dialect: whenever text crosses languages, a saying
// travels by its meaning (IDIOM_RULE).

const DIALECTS: Record<string, Record<string, string>> = {
  es: {
    VE: "Venezuelan Spanish",
    CO: "Colombian Spanish",
    MX: "Mexican Spanish",
    AR: "Argentine (Rioplatense) Spanish",
    CL: "Chilean Spanish",
    PE: "Peruvian Spanish",
    CU: "Cuban Spanish",
    PR: "Puerto Rican Spanish",
    DO: "Dominican Spanish",
    US: "US Spanish",
    ES: "Spanish as spoken in Spain"
  },
  en: {
    US: "American English",
    GB: "British English",
    AU: "Australian English",
    CA: "Canadian English",
    IE: "Irish English"
  },
  pt: { BR: "Brazilian Portuguese", PT: "European Portuguese" },
  fr: { FR: "French as spoken in France", CA: "Québécois French" },
  de: { DE: "German as spoken in Germany", AT: "Austrian German", CH: "Swiss German" }
};

/** The regions offered for a language (for docs and tests). */
export function dialectRegions(language: string): string[] {
  return Object.keys(DIALECTS[language] ?? {});
}

export type Dialects = Record<string, string>;

/**
 * A `dialects` field (a JSON string from a form, or an object from a JSON
 * body) → language code → region code, keeping only pairs in the table.
 */
export function parseDialects(value: unknown): Dialects {
  let obj: unknown = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Dialects = {};
  for (const [language, region] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof region === "string" && DIALECTS[language]?.[region]) out[language] = region;
  }
  return out;
}

/** "Venezuelan Spanish", or null when no dialect was chosen for `language`. */
export function dialectLabel(dialects: Dialects, language: string | null | undefined): string | null {
  if (!language) return null;
  const region = dialects[language];
  return (region && DIALECTS[language]?.[region]) || null;
}

/**
 * How sayings cross languages. Stated as the behaviour wanted (the house rule
 * in lib/dictate/prompt.ts): meaning first, the target's own saying where one
 * exists, and a half-said saying is still that saying.
 */
export const IDIOM_RULE =
  `Idioms and sayings travel by their meaning: where the other language has its own saying ` +
  `for the same idea, use that saying; otherwise say plainly what it means. A saying that is ` +
  `only half said ("a bird in the hand…") is still that saying, with its full meaning. `;

/** The writer reads the source as its dialect. Empty when none was chosen. */
export function readAsLine(label: string | null, who: string): string {
  return label
    ? `${who} uses ${label}: read every regional word, slang term and expression with the ` +
        `meaning it has in ${label}. `
    : "";
}

/** The writer writes for a reader of this dialect. Empty when none was chosen. */
export function writeForLine(label: string | null): string {
  return label
    ? `Write it in ${label}: choose the words, spellings and expressions a reader of ${label} ` +
        `uses, each one carrying the intended meaning there. `
    : "";
}

/**
 * The Decoder sees either side of the pair, so it gets the whole map:
 * "Spanish here is Venezuelan Spanish and English is American English".
 * `pairs` is [language label, dialect label | null]. Empty when no dialect.
 */
export function conversationDialectLine(pairs: [string, string | null][]): string {
  const known = pairs.filter((p): p is [string, string] => Boolean(p[1]));
  if (!known.length) return "";
  const list = known.map(([lang, dialect]) => `${lang} is ${dialect}`).join(" and ");
  return (
    `In this conversation ${list}: read every regional word, slang term and expression with ` +
    `the meaning it has in that dialect, and write the translation in the words a reader of ` +
    `that dialect uses. `
  );
}
