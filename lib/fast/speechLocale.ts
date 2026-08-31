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
 * The most candidate languages Azure will identify between.
 *
 * FOUR, and the number is a consequence of picking the right MODE rather than
 * an arbitrary ceiling. Azure has two kinds of language identification:
 *
 *   at-start    decides once, from the opening audio, then recognises the
 *               rest in that language.       ── up to 4 candidates
 *   continuous  re-decides throughout, so one recording can change language
 *               halfway.                     ── up to 10 candidates
 *
 * A quickie is ONE phrase said by ONE person: "where is the pharmacy", said
 * in one language, into a box with a swap button under it. Nobody changes
 * language mid-phrase here — and continuous LID pays for the ability with
 * latency on every segment, on the one screen whose entire promise is that
 * the words are already there. So /fast asks for at-start, and at-start is
 * where the 4 comes from.
 *
 * (Azure also warns that LID returns one of the candidates even when the
 * audio was none of them, which is the other reason to keep the list short
 * and near the conversation: a wide list is a wider chance of a confident
 * wrong answer.)
 */
export const MAX_SPEECH_CANDIDATES = 4;

/**
 * The languages to tell Azure to listen for, or null to use the batch mic.
 *
 * ── Why the pair is required and the rest is filler ────────────────────────
 * Both sides of the pair come first and BOTH must be streamable, or this
 * answers null. That is the load-bearing rule: /fast dictates in auto-detect
 * because the box does not know which of the two pills is about to be spoken,
 * so a recognizer that can hear only one side of the pair is not a cheaper
 * version of this feature — it is one that silently mis-transcribes every
 * sentence said in the other language. Whisper hears all 100, so the honest
 * answer there is to fall back to it.
 *
 * The remaining slots are filled from the pill row (the pair plus recently
 * used languages, lib/translate/pinned.ts) because that row IS this phone's
 * answer to "what languages is this person actually in the middle of?" — a
 * phone that has been reaching for Italian all week is more likely to hear
 * Italian than any list a stranger could have guessed. Slots left over are
 * left empty rather than padded from the catalog: a candidate that nobody on
 * this phone has ever used cannot help detection and can only add a language
 * for a confident wrong answer to land in.
 *
 * Returns Azure locales, de-duplicated (two catalog rows can map to one
 * locale) and capped at MAX_SPEECH_CANDIDATES.
 */
export function speechCandidates(
  pair: readonly [LanguageCode, LanguageCode],
  recents: readonly string[] = []
): string[] | null {
  const locales: string[] = [];
  const seen = new Set<string>();

  for (const code of pair) {
    const locale = speechLocale(code);
    if (!locale) return null; // one side unhearable — Whisper takes the whole job
    if (!seen.has(locale)) {
      seen.add(locale);
      locales.push(locale);
    }
  }

  for (const code of recents) {
    if (locales.length >= MAX_SPEECH_CANDIDATES) break;
    const locale = speechLocale(code);
    if (!locale || seen.has(locale)) continue;
    seen.add(locale);
    locales.push(locale);
  }

  return locales;
}
