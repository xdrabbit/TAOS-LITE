// Azure Translator (Text Translation REST v3) — the literal engine for /fast.
//
// ── Why a second translation provider at all ───────────────────────────────
// Every other translation surface in this app is deliberately NOT literal.
// /api/text-translate asks for "the way a fluent friend would say it"; the
// realtime interpreters carry tone. That is the product. /fast is the
// opposite on purpose: the Google-quickie moment, where you want the plain
// word and not an interpretation of it. A neural MT service is built for
// exactly that register and nothing else, which is why it was the first
// candidate — see docs/fast-engine.md for what the measurements said.
//
// ── A SEPARATE Azure resource from Speech ──────────────────────────────────
// The app already has AZURE_SPEECH_KEY / AZURE_SPEECH_REGION (tutor Crawl
// pronunciation scoring, app/api/tutor/assess). Those belong to a **Speech**
// resource and they do NOT open this API: Translator is its own resource kind
// with its own keys, and a Speech key sent here comes back 401. So this reads
// AZURE_TRANSLATOR_KEY / AZURE_TRANSLATOR_REGION and, when they are absent,
// says so instead of guessing — the Stripe-cutover guard pattern. Setup steps
// for creating the resource are in docs/fast-engine.md.
import { type LanguageCode } from "@/lib/languages/catalog";

/** Azure's global endpoint. Regional endpoints exist; the global one routes. */
export const AZURE_TRANSLATOR_ENDPOINT =
  process.env.AZURE_TRANSLATOR_ENDPOINT?.trim() ||
  "https://api.cognitive.microsofttranslator.com";

/**
 * Catalog code → Azure Translator code, for the rows where they differ.
 *
 * Our codes are Whisper's (lib/languages/catalog.ts says why); Azure's are
 * its own. Ninety of the hundred agree letter for letter. These five do not,
 * and each one is a script or a dialect choice rather than a rename:
 *
 *   zh  → zh-Hans  Whisper's "zh" is Mandarin; Azure splits by SCRIPT, and
 *                  Simplified is what the catalog's 中文 row means. (yue is
 *                  its own row in both, so Cantonese is unaffected.)
 *   tl  → fil      Azure ships Filipino, the standardised register of Tagalog.
 *   no  → nb       Azure has no macrolanguage "no"; Bokmål is the written
 *                  form the catalog's Norsk row means (nn is its own row).
 *   mn  → mn-Cyrl  Mongolian in Cyrillic, which is what Mongolia writes.
 *   sr  → sr-Cyrl  Serbian in Cyrillic. sr-Latn also exists; Cyrillic is the
 *                  official script and the one the catalog's Српски shows.
 *
 * Verified against the live list on 2026-08-30:
 *   curl "https://api.cognitive.microsofttranslator.com/languages?api-version=3.0&scope=translation"
 * (that endpoint needs no key, which is what makes this table checkable.)
 */
export const AZURE_CODE_OVERRIDES: Readonly<Record<string, string>> = {
  zh: "zh-Hans",
  tl: "fil",
  no: "nb",
  mn: "mn-Cyrl",
  sr: "sr-Cyrl"
};

/**
 * The ten catalog languages Azure Translator cannot do AT ALL.
 *
 * Not a rename, not a script — absent from its supported list. Whisper can
 * hear all of them, so they are real rows on the pill sheet, and a /fast that
 * simply failed on them would be a screen that works for ninety languages and
 * dies silently on ten. `fastEngineFor()` routes them to the LLM engine
 * instead, which is the other half of why /fast carries two engines.
 *
 * Same verification command as above.
 */
export const AZURE_UNSUPPORTED: readonly string[] = [
  "br", // Breton
  "haw", // Hawaiian
  "jw", // Javanese
  "la", // Latin
  "nn", // Norwegian Nynorsk
  "oc", // Occitan
  "sa", // Sanskrit
  "su", // Sundanese
  "tg", // Tajik
  "yi" // Yiddish
];

const UNSUPPORTED = new Set<string>(AZURE_UNSUPPORTED);

/** The code Azure knows this language by, or null when it does not know it. */
export function azureCode(code: LanguageCode): string | null {
  if (UNSUPPORTED.has(code)) return null;
  return AZURE_CODE_OVERRIDES[code] ?? code;
}

export interface AzureCredentials {
  key: string;
  region: string;
}

/**
 * The Translator credentials, or null when the resource has not been created.
 *
 * BOTH halves are required. A Translator key is scoped to the region its
 * resource lives in and the API rejects it without the `Ocp-Apim-Subscription-
 * Region` header, so a key on its own is not a usable credential — treating
 * it as one would turn a missing env var into a 401 nobody can read.
 */
export function azureCredentials(): AzureCredentials | null {
  const key = process.env.AZURE_TRANSLATOR_KEY?.trim();
  const region = process.env.AZURE_TRANSLATOR_REGION?.trim();
  if (!key || !region) return null;
  return { key, region };
}

/** Thrown when Azure answers with a non-2xx or a body we cannot read. */
export class AzureTranslatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureTranslatorError";
  }
}

export interface AzureResult {
  translation: string;
  /** Which side of the pair the input turned out to be in. */
  detectedSource: LanguageCode;
}

/**
 * Which side of the pair Azure says it detected.
 *
 * Exact match first, then the part before the hyphen — Azure answers detection
 * with a plain "zh" where the translation targets are "zh-Hans"/"zh-Hant", and
 * with "sr-Cyrl" where a detector elsewhere might say "sr". Anything that is
 * neither side of the pair reads as the phone owner's side: an input in a
 * third language is not a direction this screen has, and translating it INTO
 * the other side keeps the answer inside the conversation the pills describe.
 */
export function sideForDetected(
  detected: string,
  pair: readonly [LanguageCode, LanguageCode]
): LanguageCode {
  const want = detected.toLowerCase();
  const base = want.split("-")[0];
  for (const code of pair) {
    const azure = azureCode(code)?.toLowerCase();
    if (azure && (azure === want || azure.split("-")[0] === base)) return code;
  }
  return pair[0];
}

/**
 * One literal translation between the two sides of a pair.
 *
 * `source` names the side the text is in; `null` asks Azure to work it out.
 *
 * ── How auto-detect is done, and what it costs ─────────────────────────────
 * Auto sends NO `from` and BOTH pair languages as `to`, in one request. Azure
 * detects the source, translates into both, and we keep the one that is not
 * the language the text was already in.
 *
 * That bills the source characters TWICE (Azure charges per character per
 * target), which is worth naming: a 30-character quickie goes from $0.0003 to
 * $0.0006. It buys a single round trip. The alternative — POST /detect, then
 * POST /translate — bills once but costs a second network round trip on the
 * one screen whose entire promise is that the answer is already there. On a
 * surface this cheap per call, latency is the scarcer resource.
 *
 * There is no prompt here and nothing to fence: an MT model cannot be talked
 * into answering the question instead of translating it, which is the one
 * thing this engine gets for free that the LLM engine has to be told.
 */
export async function azureTranslatePair(
  credentials: AzureCredentials,
  text: string,
  pair: readonly [LanguageCode, LanguageCode],
  source: LanguageCode | null
): Promise<AzureResult> {
  const [mine, theirs] = pair;
  const azureMine = azureCode(mine);
  const azureTheirs = azureCode(theirs);
  if (!azureMine || !azureTheirs) {
    throw new AzureTranslatorError(
      `Azure Translator does not support ${!azureMine ? mine : theirs}.`
    );
  }

  const params = new URLSearchParams({ "api-version": "3.0", textType: "plain" });
  if (source) {
    const from = azureCode(source);
    if (!from) throw new AzureTranslatorError(`Azure Translator does not support ${source}.`);
    params.set("from", from);
    params.append("to", source === mine ? azureTheirs : azureMine);
  } else {
    params.append("to", azureMine);
    params.append("to", azureTheirs);
  }

  let res: Response;
  try {
    res = await fetch(`${AZURE_TRANSLATOR_ENDPOINT}/translate?${params.toString()}`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": credentials.key,
        "Ocp-Apim-Subscription-Region": credentials.region,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([{ Text: text }]),
      cache: "no-store"
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network error";
    throw new AzureTranslatorError(`Failed to reach Azure Translator: ${detail}`);
  }

  const payload = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const detail = payload ? JSON.stringify(payload) : `HTTP ${res.status}`;
    throw new AzureTranslatorError(`Azure Translator request failed: ${detail}`);
  }

  // v3 answers with one entry per input string; we send one.
  const first = Array.isArray(payload) ? (payload[0] as Record<string, unknown>) : null;
  const translations = (Array.isArray(first?.translations) ? first?.translations : []) as Array<
    Record<string, unknown>
  >;

  const detectedRaw = (first?.detectedLanguage as Record<string, unknown> | undefined)?.language;
  const detectedSource: LanguageCode = source
    ? source
    : sideForDetected(typeof detectedRaw === "string" ? detectedRaw : "", pair);

  // Fixed direction asked for one target, so take it. Auto asked for two, so
  // keep the one whose target is NOT the language the text was already in.
  const wantedTo = (detectedSource === mine ? azureTheirs : azureMine).toLowerCase();
  const picked = source
    ? translations[0]
    : (translations.find((t) => String(t.to ?? "").toLowerCase() === wantedTo) ?? translations[0]);

  const out = typeof picked?.text === "string" ? picked.text.trim() : "";
  if (!out) throw new AzureTranslatorError("Azure Translator returned an empty translation.");
  return { translation: out, detectedSource };
}
