export const AUTO_DETECT_LANGUAGE = "auto" as const;
export const DEFAULT_SOURCE_LANGUAGE = "en" as const;
export const DEFAULT_TARGET_LANGUAGE = "es" as const;

export const LANGUAGE_OPTIONS = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "hi", label: "Hindi" },
  { code: "ar", label: "Arabic" },
  { code: "ru", label: "Russian" }
] as const;

export type SupportedLanguageCode = (typeof LANGUAGE_OPTIONS)[number]["code"];
export type SourceLanguageCode = SupportedLanguageCode | typeof AUTO_DETECT_LANGUAGE;

export const SOURCE_LANGUAGE_OPTIONS = [
  { code: AUTO_DETECT_LANGUAGE, label: "Auto detect" },
  ...LANGUAGE_OPTIONS
] as const;

const SUPPORTED_LANGUAGE_SET = new Set<SupportedLanguageCode>(
  LANGUAGE_OPTIONS.map((language) => language.code)
);

export function isSupportedLanguageCode(value: string): value is SupportedLanguageCode {
  return SUPPORTED_LANGUAGE_SET.has(value as SupportedLanguageCode);
}

export function isSourceLanguageCode(value: string): value is SourceLanguageCode {
  return value === AUTO_DETECT_LANGUAGE || isSupportedLanguageCode(value);
}

export function getLanguageLabel(code: SourceLanguageCode | SupportedLanguageCode): string {
  if (code === AUTO_DETECT_LANGUAGE) {
    return "Auto detect";
  }

  return LANGUAGE_OPTIONS.find((language) => language.code === code)?.label ?? code.toUpperCase();
}
