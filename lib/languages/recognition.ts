// Whisper's code → the tag the browser's SpeechRecognition wants.
//
// /live's on-device engine is the one place in TAOS that does not talk to a
// provider we control: it hands a language tag to the browser's Web Speech
// API and takes what it gets. That API wants BCP-47 ("es-ES", "pt-BR"), while
// every other id in the app is Whisper's (lib/languages/catalog.ts). The two
// agree for most of the hundred — "it" is a perfectly good BCP-47 tag and
// browsers pick a sensible region for it — but they disagree in three ways
// worth writing down:
//
//   • Regional splits that matter to a recognizer. "pt" is Portugal or Brazil
//     and they are not interchangeable at a dinner table; same for zh, and for
//     the handful below where TAOS knows which region its users are in.
//   • Codes Whisper spells differently. "jw" is Javanese; BCP-47 calls it
//     "jv". A recognizer handed "jw" quietly falls back to the page language,
//     which looks exactly like a broken mic.
//   • Codes that need a script. Cantonese is "yue-Hant-HK" or it is nothing.
//
// Everything not listed passes through as-is. That is the deliberate default:
// a language the browser cannot recognize fails the same way it did before
// this file existed (recognition simply returns nothing), and the ambient
// engine — which hears any language, no tag required — is the answer for it.
// This map is a place to record what the field teaches, not a gate.

const RECOGNITION_TAGS: Record<string, string> = {
  ar: "ar-SA",
  bn: "bn-BD",
  cs: "cs-CZ",
  da: "da-DK",
  de: "de-DE",
  el: "el-GR",
  en: "en-US",
  es: "es-ES",
  fa: "fa-IR",
  fi: "fi-FI",
  fr: "fr-FR",
  he: "he-IL",
  hi: "hi-IN",
  hu: "hu-HU",
  id: "id-ID",
  it: "it-IT",
  ja: "ja-JP",
  jw: "jv-ID", // Whisper spells Javanese "jw"; BCP-47 spells it "jv"
  ko: "ko-KR",
  ms: "ms-MY",
  nl: "nl-NL",
  no: "nb-NO", // Whisper's "no" is Bokmål in practice
  pl: "pl-PL",
  pt: "pt-PT",
  ro: "ro-RO",
  ru: "ru-RU",
  sk: "sk-SK",
  sv: "sv-SE",
  ta: "ta-IN",
  th: "th-TH",
  tl: "fil-PH", // Whisper's "tl" is what the phones call Filipino
  tr: "tr-TR",
  uk: "uk-UA",
  vi: "vi-VN",
  yue: "yue-Hant-HK",
  zh: "zh-CN"
};

/**
 * The tag to hand SpeechRecognition.lang for a catalog language.
 *
 * Never throws and never returns empty: an unknown code comes back unchanged,
 * because a browser given a tag it does not know picks a default, and a
 * browser given "" is a browser transcribing the page's language into a
 * summary nobody asked for.
 */
export function recognitionTag(code: string): string {
  return RECOGNITION_TAGS[code] ?? code;
}
