// Which languages Crawl can actually SCORE, and what to call them.
//
// Crawl's whole promise is that a number comes back — the learner says the
// phrase and Azure says 72. That promise is not available in every language
// the tutor can teach: Azure's pronunciation assessment supports 34 locales,
// which is 24 of the catalog's 100 (lib/languages/catalog.ts).
//
// The list below is Microsoft's, not a guess:
//   https://learn.microsoft.com/azure/ai-services/speech-service/language-support?tabs=pronunciation-assessment
//   (verified against the docs source, 2026-08-25)
//
// This is a THIRD tier and it is worth naming as one, because the app already
// has two and they mean different things:
//
//   catalog stt  — Whisper can hear it              (all 100)
//   catalog tts  — ElevenLabs can speak it          (34; tier 2 is text-only)
//   HERE         — Azure can score a repetition     (24)
//
// A module in an unscorable language is still a lesson: the phrases, the
// contrast hook and the roleplay all work, and Crawl simply shows the phrase
// and its meaning without a score. That degrade has to be SAID out loud on
// the card, the way tier 2 says "text only" — a scoring button that silently
// does nothing is the /live on-device bug all over again.

/**
 * Catalog code → the locale Azure assesses it in.
 *
 * Where Azure offers several regional variants, the choice is written down
 * rather than left to look inevitable:
 *
 *   es → es-MX, not es-ES. This household's Spanish is Liz's, and Liz is
 *        Venezuelan; Latin American vowels and seseo are what Tom is actually
 *        practising toward. A learner in Madrid is mildly mis-scored by this
 *        and that is the trade being made.
 *   pt → pt-BR, on population and on where travelers go.
 *   ar → ar-EG, the most widely understood spoken variety; MSA is not a
 *        conversation.
 *   zh/yue → zh-CN and zh-HK, matching how the catalog splits them.
 *   en → en-US, which is also the only locale with prosody and phoneme names.
 */
const ASSESSMENT_LOCALES: Readonly<Record<string, string>> = {
  ar: "ar-EG",
  ca: "ca-ES",
  da: "da-DK",
  de: "de-DE",
  en: "en-US",
  es: "es-MX",
  fi: "fi-FI",
  fr: "fr-FR",
  hi: "hi-IN",
  it: "it-IT",
  ja: "ja-JP",
  ko: "ko-KR",
  ms: "ms-MY",
  nl: "nl-NL",
  no: "nb-NO",
  pl: "pl-PL",
  pt: "pt-BR",
  ru: "ru-RU",
  sv: "sv-SE",
  ta: "ta-IN",
  th: "th-TH",
  vi: "vi-VN",
  yue: "zh-HK",
  zh: "zh-CN"
};

/** The locale Azure should score this catalog language in, or null. */
export function assessmentLocale(code: string): string | null {
  return ASSESSMENT_LOCALES[code] ?? null;
}

/** Can Crawl put a number on a repetition in this language? */
export function canAssessPronunciation(code: string): boolean {
  return code in ASSESSMENT_LOCALES;
}

/** The catalog codes Crawl can score. Sorted, so tests and UI read the same. */
export const ASSESSABLE_LANGUAGES: readonly string[] = Object.keys(ASSESSMENT_LOCALES).sort();

/**
 * What the assess route was actually asked for.
 *
 * The legacy 30-day drills send a full locale ("en-US") and the module lessons
 * send a catalog code ("es"), so both are accepted here rather than in two
 * places. An unrecognized value answers null and the route says scoring is not
 * available — it does not fall back to English, which would score a Spanish
 * phrase against an English acoustic model and hand back a confident 30.
 */
export function resolveAssessmentLocale(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (/^[a-z]{2,3}-[A-Za-z]{2,4}$/.test(raw)) return raw;
  return assessmentLocale(raw.toLowerCase());
}
