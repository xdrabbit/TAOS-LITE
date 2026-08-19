// Which two languages a POST /api/text-translate call is about.
//
// Pure, and outside the route, for the same reason buildInstructions and
// nextPair are: it is the part with the rules in it, and a route handler is
// the one place in this codebase a test cannot reach without a server.
//
// The route used to answer this with `"en-es" | "es-en"` and a private
// `{ es: "Spanish", en: "English" }` table — the two-language ceiling that
// kept /translate's typing surface on EN⇄ES while the pills next to it could
// already reach a hundred (8/19).
import { isLanguageCode, type LanguageCode } from "@/lib/languages/catalog";

/**
 * The pair to fall back on when a request names no languages at all — the
 * documented default of the old contract (docs/api-translation.md), kept so a
 * body of `{ text }` alone still behaves exactly as it did.
 */
export const FALLBACK_PAIR: readonly [LanguageCode, LanguageCode] = ["en", "es"];

export interface TextLanguages {
  /** The two languages in play. */
  pair: readonly [LanguageCode, LanguageCode];
  /** null = auto-detect which side of the pair the text is written in. */
  source: LanguageCode | null;
}

/** A repeated language: the one thing the pair rule cannot mean. */
export const SAME_LANGUAGE = "same" as const;

function asCode(value: unknown): LanguageCode | null {
  return typeof value === "string" && isLanguageCode(value) ? value : null;
}

/**
 * Which two languages, and whether the source is known.
 *
 * Precedence is explicit pair, then the legacy direction string, then the
 * fallback pair — so a caller that sends both gets the language codes it
 * asked for rather than whatever the old string said.
 */
export function resolveTextLanguages(
  payload: Record<string, unknown>
): TextLanguages | typeof SAME_LANGUAGE {
  const source = asCode(payload.sourceLanguage);
  const target = asCode(payload.targetLanguage);

  if (source && target) {
    // A pair of one repeated language would ask the model to choose between a
    // language and itself. The pill rule (lib/translate/pair.ts) cannot
    // produce one, so this is a caller bug and says so rather than guessing.
    if (source === target) return SAME_LANGUAGE;
    // "auto" is a DIRECTION, not a language, so it survives an explicit pair:
    // the caller knows the two sides but not which of them typed.
    return { pair: [source, target], source: payload.direction === "auto" ? null : source };
  }

  // Legacy: the two-string form, still documented and still cheap to honour.
  if (payload.direction === "es-en") return { pair: ["es", "en"], source: "es" };
  if (payload.direction === "en-es") return { pair: ["en", "es"], source: "en" };

  // One side named and the other missing is not enough to translate BETWEEN
  // two languages — fall back to the pair rather than inventing the other half.
  return { pair: FALLBACK_PAIR, source: null };
}

/** The other side of the pair from `code`. */
export function otherSide(
  pair: readonly [LanguageCode, LanguageCode],
  code: LanguageCode
): LanguageCode {
  return code === pair[0] ? pair[1] : pair[0];
}
