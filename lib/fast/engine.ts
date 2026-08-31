// Which engine translates one /fast quickie, and what it costs.
//
// ── The bake-off, in one paragraph ─────────────────────────────────────────
// Measured 2026-08-30 on the same ten fixtures in EN→ES and EN→PL
// (tests/live-fire/fast-engine.measure.ts; the full table is in
// docs/fast-engine.md). Azure Translator is PRIMARY: a neural MT model gives
// the plain, literal register for free, where an LLM has to be argued into it
// by prompt — and the first version of that argument produced Polish with an
// English "the" left standing in it. It is also roughly five times faster,
// which is what an as-you-type box is actually buying.
//
// gpt-4.1-nano is the fallback, and a real one rather than a courtesy: with
// the corrected fence it was the most literal of the three LLMs measured
// ("cuesta un brazo y una pierna" where gpt-5.4-nano drifted to "cuesta un
// majątek"), and it is ~12x CHEAPER per quickie than Azure — the one number
// in this whole exercise that came out backwards from the assumption.
//
// It runs in two cases:
//   1. Azure has no key. /fast still works; the response says which engine
//      answered, so nobody reads an LLM translation believing it came from
//      Azure. Setup steps for the resource are in docs/fast-engine.md.
//   2. The pair contains one of the ten catalog languages Azure cannot do at
//      all (lib/fast/azure.ts, AZURE_UNSUPPORTED). /fast is wired to the full
//      hundred, and a screen that dies on ten of them is not.
import { languageLabel, type LanguageCode } from "@/lib/languages/catalog";
import { chatCompletion, getOpenAIKey, ProviderError } from "@/lib/translateProvider";
import { buildLiteralInstructions, buildLiteralAutoInstructions } from "./prompt";
import { azureCode, azureCredentials, azureTranslatePair, AzureTranslatorError } from "./azure";

/** Which engine answered. Returned to the client and shown on screen. */
export type FastEngine = "azure" | "openai";

/**
 * The literal LLM.
 *
 * NOT OPENAI_PARAPHRASE_MODEL, which is what every other translation route
 * reuses. That var is the app's "fast mini tier" knob and points at
 * gpt-4.1-mini; on the /fast fixtures mini was four times the price of nano
 * and drifted idiomatic on exactly the inputs this screen exists for
 * ("I am looking forward to it" → "Nie mogę się tego doczekać"). A screen
 * whose whole brand is the literal register should not follow a var somebody
 * may retune for a different one.
 */
export function getFastModel(): string {
  return process.env.OPENAI_FAST_MODEL?.trim() || "gpt-4.1-nano";
}

/** Why the LLM is answering instead of Azure. Null when Azure answered. */
export type FastFallbackReason = "azure_not_configured" | "azure_unsupported_language";

export interface FastTranslation {
  translation: string;
  /** Which side of the pair the input was in — echoed back for auto mode. */
  detectedSource: LanguageCode;
  targetLanguage: LanguageCode;
  engine: FastEngine;
  /** Null when Azure took the turn. */
  fallback: FastFallbackReason | null;
}

/** Thrown when neither engine could answer. Routes map this to a 502 / 500. */
export class FastEngineError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "FastEngineError";
    this.status = status;
  }
}

/**
 * Which engine SHOULD take this pair, without calling anything.
 *
 * Split out from the translation so the route can report the choice on a
 * GET (the shell shows the engine badge before anybody types) and so the
 * decision is unit-testable without a provider.
 */
export function fastEngineFor(
  source: LanguageCode,
  target: LanguageCode
): { engine: FastEngine; fallback: FastFallbackReason | null } {
  if (!azureCredentials()) return { engine: "openai", fallback: "azure_not_configured" };
  if (!azureCode(source) || !azureCode(target)) {
    return { engine: "openai", fallback: "azure_unsupported_language" };
  }
  return { engine: "azure", fallback: null };
}

/**
 * One literal translation between the two sides of a pair.
 *
 * `source` names the side the text is in; `null` means auto — work out which
 * of the two the writer typed, and translate into the other. Auto is scoped to
 * the PAIR rather than to every language there is, for the same reason
 * /api/translate scopes its detector: the pills already said which two
 * languages are in play, and a detector free to answer with a third one is
 * only free to be wrong. A third language reads as the phone owner's side.
 *
 * A failing Azure call is NOT retried on the LLM. That would double the
 * latency of the slow case and, worse, make an outage invisible — the screen
 * would quietly change register mid-session and nobody would know why the
 * wording moved. The engine choice is made once, up front, from configuration
 * and the catalog; a provider that then falls over is an error the caller
 * sees.
 */
export async function fastTranslate(
  text: string,
  pair: readonly [LanguageCode, LanguageCode],
  source: LanguageCode | null
): Promise<FastTranslation> {
  const [mine, theirs] = pair;
  const { engine, fallback } = fastEngineFor(mine, theirs);

  if (engine === "azure") {
    const credentials = azureCredentials();
    // fastEngineFor already proved these; the re-read is for the type.
    if (!credentials) throw new FastEngineError("Azure Translator is not configured.", 500);
    try {
      const { translation, detectedSource } = await azureTranslatePair(
        credentials,
        text,
        pair,
        source
      );
      return {
        translation,
        detectedSource,
        targetLanguage: detectedSource === mine ? theirs : mine,
        engine: "azure",
        fallback: null
      };
    } catch (error) {
      const detail = error instanceof AzureTranslatorError ? error.message : String(error);
      throw new FastEngineError(detail);
    }
  }

  const apiKey = getOpenAIKey();
  if (!apiKey) {
    throw new FastEngineError("Server misconfiguration: missing OPENAI_API_KEY.", 500);
  }

  try {
    if (source) {
      const target = source === mine ? theirs : mine;
      const translation = await chatCompletion(apiKey, {
        model: getFastModel(),
        // Zero, not the 0.3 the conversational routes use: two people typing
        // the same phrase into a dictionary should get the same word back.
        temperature: 0,
        messages: [
          {
            role: "system",
            content: buildLiteralInstructions(languageLabel(source), languageLabel(target))
          },
          { role: "user", content: text }
        ]
      });
      return { translation, detectedSource: source, targetLanguage: target, engine: "openai", fallback };
    }

    const content = await chatCompletion(apiKey, {
      model: getFastModel(),
      temperature: 0,
      jsonMode: true,
      messages: [
        { role: "system", content: buildLiteralAutoInstructions(mine, theirs) },
        { role: "user", content: text }
      ]
    });
    let parsed: { sourceLang?: string; translation?: string } = {};
    try {
      parsed = JSON.parse(content) as { sourceLang?: string; translation?: string };
    } catch {
      throw new ProviderError("Provider returned malformed JSON for auto-detect.");
    }
    // Anything that is not the second side reads as the first — the model is
    // choosing between exactly two codes we handed it, so an unrecognised
    // answer is a malformed one, not a third language.
    const detectedSource: LanguageCode = parsed.sourceLang === theirs ? theirs : mine;
    const translation = typeof parsed.translation === "string" ? parsed.translation.trim() : "";
    if (!translation) throw new ProviderError("Provider returned an empty translation.");
    return {
      translation,
      detectedSource,
      targetLanguage: detectedSource === mine ? theirs : mine,
      engine: "openai",
      fallback
    };
  } catch (error) {
    const detail = error instanceof ProviderError ? error.message : String(error);
    throw new FastEngineError(detail);
  }
}
