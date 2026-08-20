// The server's view of the language catalog.
//
// This file used to BE the list — 13 hand-maintained {code,label} pairs that
// /api/translate, /api/vision and /api/video/process validated against, while
// TranslatorShell kept its own shorter one. Two lists, one of them always the
// stale one. Now both derive from lib/languages/catalog.ts and this module is
// just the shape the routes and the <select>s already expect: code + ENGLISH
// label, which is the pair the translation prompts interpolate.
//
// Widening it from 13 to 100 is the point (8/17): the allow-list was the thing
// standing between the phone and every language the pipeline could already
// handle. Anything Whisper can hear now passes validation and gets translated;
// whether it also comes back as AUDIO is the catalog's `tts` flag, asked
// through canSpeak() at the point of synthesis — not here.
import {
  isLanguageCode,
  languageLabel,
  SHEET_LANGUAGES,
  type LanguageCode
} from "@/lib/languages/catalog";

export const AUTO_DETECT_LANGUAGE = "auto" as const;
export const DEFAULT_SOURCE_LANGUAGE = "en" as const;
export const DEFAULT_TARGET_LANGUAGE = "es" as const;

export interface LanguageOption {
  code: LanguageCode;
  label: string;
}

// In the catalog's picker order — the twenty most useful first, then
// alphabetical — so the dropdowns that render this straight into <option>s
// (/video, /vision, /live) still open on the languages people actually pick.
export const LANGUAGE_OPTIONS: readonly LanguageOption[] = SHEET_LANGUAGES.map(
  ({ code, label }) => ({ code, label })
);

export type SupportedLanguageCode = LanguageCode;
export type SourceLanguageCode = SupportedLanguageCode | typeof AUTO_DETECT_LANGUAGE;

export const SOURCE_LANGUAGE_OPTIONS: readonly { code: SourceLanguageCode; label: string }[] = [
  { code: AUTO_DETECT_LANGUAGE, label: "Auto detect" },
  ...LANGUAGE_OPTIONS
];

export function isSupportedLanguageCode(value: string): value is SupportedLanguageCode {
  return isLanguageCode(value);
}

export function isSourceLanguageCode(value: string): value is SourceLanguageCode {
  return value === AUTO_DETECT_LANGUAGE || isSupportedLanguageCode(value);
}

export function getLanguageLabel(code: SourceLanguageCode | SupportedLanguageCode): string {
  if (code === AUTO_DETECT_LANGUAGE) {
    return "Auto detect";
  }

  return languageLabel(code);
}
