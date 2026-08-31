// Which catalog languages Azure Speech can hear LIVE, and what to call them.
//
// This is the FOURTH language tier in the app, and it is worth naming as one
// next to the three that already exist, because each answers a different
// provider's question:
//
//   catalog stt  — Whisper can hear it, in a file       (all 100)
//   catalog tts  — ElevenLabs can speak it              (34; tier 2 is text)
//   assessment   — Azure can SCORE a repetition         (24, lib/tutor)
//   HERE         — Azure can hear it as it is SPOKEN    (76)
//
// The batch mic (POST /api/fast/listen, Whisper) hears all 100 and is what
// runs when this table says null. So a language missing from here is not a
// language you cannot dictate in — it is a language you dictate in the old
// way, one lump on release, which is exactly the degrade lib/fast/useDictation
// falls back to. Nothing is lost but the liveness.
//
// The locale list is Microsoft's, not a guess:
//   https://learn.microsoft.com/azure/ai-services/speech-service/language-support?tabs=stt
//   (read from the docs source, articles/ai-services/speech-service/includes/
//   language-support/stt.md, on 2026-08-30)
import { type LanguageCode } from "@/lib/languages/catalog";

/**
 * Catalog code → the locale Azure listens in.
 *
 * Azure offers regional variants where the catalog has one row per language,
 * so a choice gets made 20-odd times and each one is a small opinion about
 * whose accent this app is for. Where the tutor already made that choice
 * (lib/tutor/pronunciation.ts) this table AGREES with it deliberately — a
 * phone that scores Tom's Spanish as es-MX and then transcribes it as es-ES
 * would be two different opinions about the same household:
 *
 *   es → es-MX   Liz is Venezuelan; Latin American vowels and seseo are what
 *                this house speaks. A speaker in Madrid is mildly mis-heard
 *                by this, and that is the trade, same as in Crawl.
 *   pt → pt-BR   population, and where travelers go.
 *   ar → ar-EG   the most widely understood spoken variety. Azure lists
 *                twenty Arabic locales; MSA is not a conversation.
 *   en → en-US   also the only English locale with the full feature set.
 *   yue → zh-HK  Azure has BOTH yue-CN (Cantonese, Simplified) and zh-HK
 *                (Cantonese, Traditional). zh-HK is what Crawl scores yue in,
 *                and Traditional is what Hong Kong writes.
 *   zh → zh-CN   Mandarin, Simplified — what the catalog's 中文 row means.
 *   sw → sw-KE   Kenya over Tanzania on traveler numbers; both exist.
 *   sr → sr-RS   Serbia, not Montenegro (sr-ME) or Kosovo (sr-XK).
 *   no → nb-NO   Azure has no macrolanguage Norwegian; Bokmål is the written
 *                form the catalog's Norsk row means (nn is its own row, and
 *                Azure has no Nynorsk at all — so nn is absent below).
 *   tl → fil-PH  Azure ships Filipino, the standardised register of Tagalog.
 *                Same substitution the Translator table makes (lib/fast/azure).
 *   jw → jv-ID   the catalog carries Whisper's "jw"; Azure spells it "jv".
 */
const SPEECH_LOCALES: Readonly<Record<string, string>> = {
  af: "af-ZA",
  am: "am-ET",
  ar: "ar-EG",
  as: "as-IN",
  az: "az-AZ",
  bg: "bg-BG",
  bn: "bn-IN",
  bs: "bs-BA",
  ca: "ca-ES",
  cs: "cs-CZ",
  cy: "cy-GB",
  da: "da-DK",
  de: "de-DE",
  el: "el-GR",
  en: "en-US",
  es: "es-MX",
  et: "et-EE",
  eu: "eu-ES",
  fa: "fa-IR",
  fi: "fi-FI",
  fr: "fr-FR",
  gl: "gl-ES",
  gu: "gu-IN",
  he: "he-IL",
  hi: "hi-IN",
  hr: "hr-HR",
  hu: "hu-HU",
  hy: "hy-AM",
  id: "id-ID",
  is: "is-IS",
  it: "it-IT",
  ja: "ja-JP",
  jw: "jv-ID",
  ka: "ka-GE",
  kk: "kk-KZ",
  km: "km-KH",
  kn: "kn-IN",
  ko: "ko-KR",
  lo: "lo-LA",
  lt: "lt-LT",
  lv: "lv-LV",
  mk: "mk-MK",
  ml: "ml-IN",
  mn: "mn-MN",
  mr: "mr-IN",
  ms: "ms-MY",
  mt: "mt-MT",
  my: "my-MM",
  ne: "ne-NP",
  nl: "nl-NL",
  no: "nb-NO",
  pa: "pa-IN",
  pl: "pl-PL",
  ps: "ps-AF",
  pt: "pt-BR",
  ro: "ro-RO",
  ru: "ru-RU",
  si: "si-LK",
  sk: "sk-SK",
  sl: "sl-SI",
  so: "so-SO",
  sq: "sq-AL",
  sr: "sr-RS",
  sv: "sv-SE",
  sw: "sw-KE",
  ta: "ta-IN",
  te: "te-IN",
  th: "th-TH",
  tl: "fil-PH",
  tr: "tr-TR",
  uk: "uk-UA",
  ur: "ur-IN",
  uz: "uz-UZ",
  vi: "vi-VN",
  yue: "zh-HK",
  zh: "zh-CN"
};

/** The locale Azure should listen in, or null when it cannot hear this one. */
export function speechLocale(code: string): string | null {
  return SPEECH_LOCALES[code] ?? null;
}

/** The catalog codes Azure can hear live. Sorted, so tests read in order. */
export const STREAMABLE_LANGUAGES: readonly string[] = Object.keys(SPEECH_LOCALES).sort();

/**
 * The most languages Azure is ever asked to identify between here: TWO.
 *
 * This number was chosen by MEASUREMENT, not by the API's ceiling, and the
 * measurement said something different from what the ceiling implied. Azure
 * allows 4 candidates for at-start language identification and 10 for
 * continuous, so the obvious design was "fill the list" — the pair plus
 * whatever else this phone has been reaching for. That is exactly wrong.
 *
 * Time to the FIRST word appearing, same 4.15s clip, pushed at wall-clock
 * speed, two runs each (docs/fast-engine.md has the rig):
 *
 *   1 language, no LID       795 / 821 ms     <- genuinely live
 *   2 candidates, Continuous 2422 / 2416 ms
 *   2 candidates, AtStart    3826 / 3845 ms
 *   4 candidates, AtStart    3806 / 3807 ms
 *   4 candidates, Continuous 4493 / 4494 ms   <- worse than saying nothing
 *
 * Every one of those transcribed the sentence identically. So the extra
 * candidates bought NOTHING and cost up to two seconds of the exact thing
 * this feature exists to provide. On a quickie — which is often shorter than
 * four seconds — a four-candidate list means the words appear after you have
 * already stopped talking, which is the batch mic with extra steps.
 *
 * Hence two, and only ever the two on the pills. A third language could not
 * help anyway: /fast translates BETWEEN the two pills, so a sentence
 * confidently recognised in a language that is on neither of them is a
 * sentence this screen cannot do anything with.
 */
export const MAX_SPEECH_CANDIDATES = 2;

/**
 * Whether to make Azure identify the language at all, and how.
 *
 * "Continuous" over "AtStart" purely on the numbers above — 2.4s against
 * 3.8s for the same two candidates and the same transcript. The name is
 * misleading for this use: it does not mean /fast expects somebody to change
 * language mid-phrase, only that Azure keeps deciding rather than buffering
 * ~3 seconds up front to decide once. Buffering is precisely what this screen
 * cannot afford.
 */
export const SPEECH_LANGUAGE_ID_MODE = "Continuous";

/**
 * The languages to tell Azure to listen for, or null to use the batch mic.
 *
 * ── Pinned is the fast path, and it is a real one ──────────────────────────
 * When the writer has pinned the direction (the swap button, or tapping off
 * the Auto chip), there is nothing to identify: one language, no LID, first
 * words in ~800ms instead of ~2400ms. That is the difference between a mic
 * that feels live and one that feels merely quick, and it is available to
 * anybody who tells the screen which way round they are talking.
 *
 * It also RESCUES pairs the auto path has to refuse. Pinned only needs the
 * one language to be streamable, so an English speaker with Latin on the
 * other pill still gets the live mic when they pin to English — where Auto
 * would have to hand the whole job to Whisper.
 *
 * ── Auto needs both sides, or nothing ──────────────────────────────────────
 * In Auto the box does not know which of the two pills is about to be spoken,
 * which is the whole point of a screen with a swap button on it. So both must
 * be streamable, or this answers null: a recogniser that can hear only one
 * side of the pair is not a cheaper version of this feature, it is one that
 * silently mis-transcribes every sentence said in the other language. Whisper
 * hears all 100, so the honest answer there is to hand it the whole job.
 *
 * Returns Azure locales, de-duplicated — two catalog rows can share a locale,
 * and asking Azure to choose between a language and itself is the slow path
 * for a decision with one answer.
 */
export function speechCandidates(
  pair: readonly [LanguageCode, LanguageCode],
  pinned: LanguageCode | null
): string[] | null {
  if (pinned) {
    const locale = speechLocale(pinned);
    return locale ? [locale] : null;
  }

  const locales: string[] = [];
  for (const code of pair) {
    const locale = speechLocale(code);
    if (!locale) return null; // one side unhearable — Whisper takes the whole job
    if (!locales.includes(locale)) locales.push(locale);
  }
  return locales;
}
