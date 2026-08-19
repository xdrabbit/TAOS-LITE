// THE language catalog — one list, for every screen and every route.
//
// Before this file there were two lists that had to be kept in step by hand:
// LANGUAGE_OPTIONS on the server (13 languages, the /api/translate allow-list)
// and PAIR_LANGUAGES + FLAGS + SPEAKERS in TranslatorShell (6). Adding a
// language meant editing both, and forgetting one gave the phone a pill whose
// turns died on a 400 "Unsupported language pair." Now lib/realtime/languages
// derives from here, so there is exactly one place to add a language: one row
// in CATALOG below.
//
// ── The two tiers ────────────────────────────────────────────────────────
// The pipeline is two providers deep, and they do NOT cover the same set:
//
//   stt  — what OpenAI's transcription models can HEAR. That is Whisper's
//          language list (100, including yue), and every row here has it:
//          the catalog IS that list. A language nobody can be heard speaking
//          has no place in a speech translator.
//   tts  — what ElevenLabs can SPEAK. The default model (eleven_turbo_v2_5,
//          and eleven_flash_v2_5 for /live) reports 32 languages from
//          GET /v1/models; two more reach speech another way (see below).
//          34 of the 100 rows, and the remaining 66 are text-only.
//
// So: TIER 1 (tts: true) is the full experience — speak, read, hear it back.
// TIER 2 (tts: false) shows the translated TEXT and skips synthesis, with a
// "text only" mark on the pill row and in the picker so nobody waits for audio
// that was never coming. A tier-2 language is not a broken language; it is a
// language you can still read a menu in and still hold a conversation through.
//
// The tts flag is the app's SINGLE answer to "can we say this out loud?", and
// it is deliberately not per-engine: OpenAI's TTS would probably manage some
// tier-2 languages, but the free tier runs on OpenAI and subscribers run on
// ElevenLabs, and a "text only" mark that quietly changed meaning when someone
// flipped the engine toggle would be a worse lie than the conservative one.
// If that trade ever stops paying, split this into ttsElevenLabs/ttsOpenAI —
// the flag is read through canSpeak() precisely so it can grow a second half.
//
// ── Adding a language ────────────────────────────────────────────────────
// Add one row. `code` must be the code the transcription model knows the
// language by (Whisper's), because that is what /api/translate reasons about;
// `label` is the ENGLISH name and is load-bearing — the prompts interpolate it
// ("The speaker talks in Bosnian"), so it has to read as a language name to a
// model. `tts` must be checked against GET /v1/models, never guessed.
//
// One row is still the whole edit here, but there is a SECOND file keyed by
// this list: lib/languages/readConfirmation.ts, one written-out sentence per
// language. It is typed `Record<LanguageCode, string>` on purpose — add a row
// below without a sentence and the build stops, rather than /chat quietly
// confirming a language change in English.
//
// Verified against both providers on 2026-08-17:
//   curl -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/models
//   https://github.com/openai/whisper -> whisper/tokenizer.py LANGUAGES

interface LanguageShape {
  /** Whisper's code for the language — the id every route speaks in. */
  code: string;
  /** ENGLISH name. Interpolated into the translation prompts; keep it real. */
  label: string;
  /** Spanish name, so Liz can search the picker in her own language. */
  labelEs: string;
  /** The language's name in itself — what the picker leads with. */
  native: string;
  flag: string;
  /** Whisper can transcribe it. True for every row; the field states the why. */
  stt: boolean;
  /** ElevenLabs can speak it. False = tier 2, text-only (TTS is skipped). */
  tts: boolean;
  /**
   * The language whose pronunciation it borrows, when the TTS model has no
   * entry of its own but renders the text acceptably as a close relative.
   */
  ttsVoiceHint?: string;
  /** 1-20 for the languages worth showing before the alphabet. */
  rank?: number;
}

// Ordered as the picker shows them: the twenty most useful first (rank), then
// everything else alphabetical by English name. SHEET_LANGUAGES re-sorts on
// these fields rather than trusting this order, but keeping the source in the
// same shape means a human reading the file sees what a human on a phone sees.
const CATALOG = [
  { code: "en", label: "English", labelEs: "Inglés", native: "English", flag: "🇺🇸", stt: true, tts: true, rank: 1 },
  { code: "es", label: "Spanish", labelEs: "Español", native: "Español", flag: "🇪🇸", stt: true, tts: true, rank: 2 },
  { code: "zh", label: "Chinese", labelEs: "Chino", native: "中文", flag: "🇨🇳", stt: true, tts: true, rank: 3 },
  { code: "hi", label: "Hindi", labelEs: "Hindi", native: "हिन्दी", flag: "🇮🇳", stt: true, tts: true, rank: 4 },
  { code: "ar", label: "Arabic", labelEs: "Árabe", native: "العربية", flag: "🇸🇦", stt: true, tts: true, rank: 5 },
  { code: "pt", label: "Portuguese", labelEs: "Portugués", native: "Português", flag: "🇵🇹", stt: true, tts: true, rank: 6 },
  { code: "ru", label: "Russian", labelEs: "Ruso", native: "Русский", flag: "🇷🇺", stt: true, tts: true, rank: 7 },
  { code: "ja", label: "Japanese", labelEs: "Japonés", native: "日本語", flag: "🇯🇵", stt: true, tts: true, rank: 8 },
  { code: "de", label: "German", labelEs: "Alemán", native: "Deutsch", flag: "🇩🇪", stt: true, tts: true, rank: 9 },
  { code: "fr", label: "French", labelEs: "Francés", native: "Français", flag: "🇫🇷", stt: true, tts: true, rank: 10 },
  { code: "it", label: "Italian", labelEs: "Italiano", native: "Italiano", flag: "🇮🇹", stt: true, tts: true, rank: 11 },
  { code: "ko", label: "Korean", labelEs: "Coreano", native: "한국어", flag: "🇰🇷", stt: true, tts: true, rank: 12 },
  { code: "tr", label: "Turkish", labelEs: "Turco", native: "Türkçe", flag: "🇹🇷", stt: true, tts: true, rank: 13 },
  { code: "vi", label: "Vietnamese", labelEs: "Vietnamita", native: "Tiếng Việt", flag: "🇻🇳", stt: true, tts: true, rank: 14 },
  { code: "pl", label: "Polish", labelEs: "Polaco", native: "Polski", flag: "🇵🇱", stt: true, tts: true, rank: 15 },
  { code: "nl", label: "Dutch", labelEs: "Neerlandés", native: "Nederlands", flag: "🇳🇱", stt: true, tts: true, rank: 16 },
  { code: "id", label: "Indonesian", labelEs: "Indonesio", native: "Bahasa Indonesia", flag: "🇮🇩", stt: true, tts: true, rank: 17 },
  { code: "bn", label: "Bengali", labelEs: "Bengalí", native: "বাংলা", flag: "🇧🇩", stt: true, tts: false, rank: 18 },
  { code: "uk", label: "Ukrainian", labelEs: "Ucraniano", native: "Українська", flag: "🇺🇦", stt: true, tts: true, rank: 19 },
  { code: "fa", label: "Persian", labelEs: "Persa", native: "فارسی", flag: "🇮🇷", stt: true, tts: false, rank: 20 },
  { code: "af", label: "Afrikaans", labelEs: "Afrikáans", native: "Afrikaans", flag: "🇿🇦", stt: true, tts: false },
  { code: "sq", label: "Albanian", labelEs: "Albanés", native: "Shqip", flag: "🇦🇱", stt: true, tts: false },
  { code: "am", label: "Amharic", labelEs: "Amárico", native: "አማርኛ", flag: "🇪🇹", stt: true, tts: false },
  { code: "hy", label: "Armenian", labelEs: "Armenio", native: "Հայերեն", flag: "🇦🇲", stt: true, tts: false },
  { code: "as", label: "Assamese", labelEs: "Asamés", native: "অসমীয়া", flag: "🇮🇳", stt: true, tts: false },
  { code: "az", label: "Azerbaijani", labelEs: "Azerbaiyano", native: "Azərbaycan", flag: "🇦🇿", stt: true, tts: false },
  { code: "ba", label: "Bashkir", labelEs: "Baskir", native: "Башҡортса", flag: "🌐", stt: true, tts: false },
  { code: "eu", label: "Basque", labelEs: "Euskera", native: "Euskara", flag: "🌐", stt: true, tts: false },
  { code: "be", label: "Belarusian", labelEs: "Bielorruso", native: "Беларуская", flag: "🇧🇾", stt: true, tts: false },
  { code: "bs", label: "Bosnian", labelEs: "Bosnio", native: "Bosanski", flag: "🇧🇦", stt: true, tts: true, ttsVoiceHint: "hr" },
  { code: "br", label: "Breton", labelEs: "Bretón", native: "Brezhoneg", flag: "🌐", stt: true, tts: false },
  { code: "bg", label: "Bulgarian", labelEs: "Búlgaro", native: "Български", flag: "🇧🇬", stt: true, tts: true },
  { code: "my", label: "Burmese", labelEs: "Birmano", native: "မြန်မာ", flag: "🇲🇲", stt: true, tts: false },
  { code: "yue", label: "Cantonese", labelEs: "Cantonés", native: "廣東話", flag: "🇭🇰", stt: true, tts: true },
  { code: "ca", label: "Catalan", labelEs: "Catalán", native: "Català", flag: "🌐", stt: true, tts: false },
  { code: "hr", label: "Croatian", labelEs: "Croata", native: "Hrvatski", flag: "🇭🇷", stt: true, tts: true },
  { code: "cs", label: "Czech", labelEs: "Checo", native: "Čeština", flag: "🇨🇿", stt: true, tts: true },
  { code: "da", label: "Danish", labelEs: "Danés", native: "Dansk", flag: "🇩🇰", stt: true, tts: true },
  { code: "et", label: "Estonian", labelEs: "Estonio", native: "Eesti", flag: "🇪🇪", stt: true, tts: false },
  { code: "fo", label: "Faroese", labelEs: "Feroés", native: "Føroyskt", flag: "🇫🇴", stt: true, tts: false },
  { code: "tl", label: "Filipino", labelEs: "Filipino", native: "Filipino", flag: "🇵🇭", stt: true, tts: true },
  { code: "fi", label: "Finnish", labelEs: "Finés", native: "Suomi", flag: "🇫🇮", stt: true, tts: true },
  { code: "gl", label: "Galician", labelEs: "Gallego", native: "Galego", flag: "🌐", stt: true, tts: false },
  { code: "ka", label: "Georgian", labelEs: "Georgiano", native: "ქართული", flag: "🇬🇪", stt: true, tts: false },
  { code: "el", label: "Greek", labelEs: "Griego", native: "Ελληνικά", flag: "🇬🇷", stt: true, tts: true },
  { code: "gu", label: "Gujarati", labelEs: "Guyaratí", native: "ગુજરાતી", flag: "🇮🇳", stt: true, tts: false },
  { code: "ht", label: "Haitian Creole", labelEs: "Criollo haitiano", native: "Kreyòl Ayisyen", flag: "🇭🇹", stt: true, tts: false },
  { code: "ha", label: "Hausa", labelEs: "Hausa", native: "Harshen Hausa", flag: "🇳🇬", stt: true, tts: false },
  { code: "haw", label: "Hawaiian", labelEs: "Hawaiano", native: "ʻŌlelo Hawaiʻi", flag: "🌐", stt: true, tts: false },
  { code: "he", label: "Hebrew", labelEs: "Hebreo", native: "עברית", flag: "🇮🇱", stt: true, tts: false },
  { code: "hu", label: "Hungarian", labelEs: "Húngaro", native: "Magyar", flag: "🇭🇺", stt: true, tts: true },
  { code: "is", label: "Icelandic", labelEs: "Islandés", native: "Íslenska", flag: "🇮🇸", stt: true, tts: false },
  { code: "jw", label: "Javanese", labelEs: "Javanés", native: "Basa Jawa", flag: "🇮🇩", stt: true, tts: false },
  { code: "kn", label: "Kannada", labelEs: "Canarés", native: "ಕನ್ನಡ", flag: "🇮🇳", stt: true, tts: false },
  { code: "kk", label: "Kazakh", labelEs: "Kazajo", native: "Қазақша", flag: "🇰🇿", stt: true, tts: false },
  { code: "km", label: "Khmer", labelEs: "Jemer", native: "ភាសាខ្មែរ", flag: "🇰🇭", stt: true, tts: false },
  { code: "lo", label: "Lao", labelEs: "Lao", native: "ລາວ", flag: "🇱🇦", stt: true, tts: false },
  { code: "la", label: "Latin", labelEs: "Latín", native: "Latina", flag: "🌐", stt: true, tts: false },
  { code: "lv", label: "Latvian", labelEs: "Letón", native: "Latviešu", flag: "🇱🇻", stt: true, tts: false },
  { code: "ln", label: "Lingala", labelEs: "Lingala", native: "Lingála", flag: "🇨🇩", stt: true, tts: false },
  { code: "lt", label: "Lithuanian", labelEs: "Lituano", native: "Lietuvių", flag: "🇱🇹", stt: true, tts: false },
  { code: "lb", label: "Luxembourgish", labelEs: "Luxemburgués", native: "Lëtzebuergesch", flag: "🇱🇺", stt: true, tts: false },
  { code: "mk", label: "Macedonian", labelEs: "Macedonio", native: "Македонски", flag: "🇲🇰", stt: true, tts: false },
  { code: "mg", label: "Malagasy", labelEs: "Malgache", native: "Malagasy", flag: "🇲🇬", stt: true, tts: false },
  { code: "ms", label: "Malay", labelEs: "Malayo", native: "Bahasa Melayu", flag: "🇲🇾", stt: true, tts: true },
  { code: "ml", label: "Malayalam", labelEs: "Malayalam", native: "മലയാളം", flag: "🇮🇳", stt: true, tts: false },
  { code: "mt", label: "Maltese", labelEs: "Maltés", native: "Malti", flag: "🇲🇹", stt: true, tts: false },
  { code: "mi", label: "Maori", labelEs: "Maorí", native: "Te Reo Māori", flag: "🇳🇿", stt: true, tts: false },
  { code: "mr", label: "Marathi", labelEs: "Maratí", native: "मराठी", flag: "🇮🇳", stt: true, tts: false },
  { code: "mn", label: "Mongolian", labelEs: "Mongol", native: "Монгол", flag: "🇲🇳", stt: true, tts: false },
  { code: "ne", label: "Nepali", labelEs: "Nepalí", native: "नेपाली", flag: "🇳🇵", stt: true, tts: false },
  { code: "no", label: "Norwegian", labelEs: "Noruego", native: "Norsk", flag: "🇳🇴", stt: true, tts: true },
  { code: "nn", label: "Norwegian Nynorsk", labelEs: "Nynorsk", native: "Nynorsk", flag: "🇳🇴", stt: true, tts: false },
  { code: "oc", label: "Occitan", labelEs: "Occitano", native: "Occitan", flag: "🌐", stt: true, tts: false },
  { code: "ps", label: "Pashto", labelEs: "Pastún", native: "پښتو", flag: "🇦🇫", stt: true, tts: false },
  { code: "pa", label: "Punjabi", labelEs: "Panyabí", native: "ਪੰਜਾਬੀ", flag: "🇮🇳", stt: true, tts: false },
  { code: "ro", label: "Romanian", labelEs: "Rumano", native: "Română", flag: "🇷🇴", stt: true, tts: true },
  { code: "sa", label: "Sanskrit", labelEs: "Sánscrito", native: "संस्कृतम्", flag: "🌐", stt: true, tts: false },
  { code: "sr", label: "Serbian", labelEs: "Serbio", native: "Српски", flag: "🇷🇸", stt: true, tts: false },
  { code: "sn", label: "Shona", labelEs: "Shona", native: "ChiShona", flag: "🇿🇼", stt: true, tts: false },
  { code: "sd", label: "Sindhi", labelEs: "Sindhi", native: "سنڌي", flag: "🇵🇰", stt: true, tts: false },
  { code: "si", label: "Sinhala", labelEs: "Cingalés", native: "සිංහල", flag: "🇱🇰", stt: true, tts: false },
  { code: "sk", label: "Slovak", labelEs: "Eslovaco", native: "Slovenčina", flag: "🇸🇰", stt: true, tts: true },
  { code: "sl", label: "Slovenian", labelEs: "Esloveno", native: "Slovenščina", flag: "🇸🇮", stt: true, tts: false },
  { code: "so", label: "Somali", labelEs: "Somalí", native: "Soomaali", flag: "🇸🇴", stt: true, tts: false },
  { code: "su", label: "Sundanese", labelEs: "Sundanés", native: "Basa Sunda", flag: "🇮🇩", stt: true, tts: false },
  { code: "sw", label: "Swahili", labelEs: "Suajili", native: "Kiswahili", flag: "🇰🇪", stt: true, tts: false },
  { code: "sv", label: "Swedish", labelEs: "Sueco", native: "Svenska", flag: "🇸🇪", stt: true, tts: true },
  { code: "tg", label: "Tajik", labelEs: "Tayiko", native: "Тоҷикӣ", flag: "🇹🇯", stt: true, tts: false },
  { code: "ta", label: "Tamil", labelEs: "Tamil", native: "தமிழ்", flag: "🇮🇳", stt: true, tts: true },
  { code: "tt", label: "Tatar", labelEs: "Tártaro", native: "Татарча", flag: "🌐", stt: true, tts: false },
  { code: "te", label: "Telugu", labelEs: "Telugu", native: "తెలుగు", flag: "🇮🇳", stt: true, tts: false },
  { code: "th", label: "Thai", labelEs: "Tailandés", native: "ไทย", flag: "🇹🇭", stt: true, tts: false },
  { code: "bo", label: "Tibetan", labelEs: "Tibetano", native: "བོད་སྐད་", flag: "🌐", stt: true, tts: false },
  { code: "tk", label: "Turkmen", labelEs: "Turcomano", native: "Türkmençe", flag: "🇹🇲", stt: true, tts: false },
  { code: "ur", label: "Urdu", labelEs: "Urdu", native: "اردو", flag: "🇵🇰", stt: true, tts: false },
  { code: "uz", label: "Uzbek", labelEs: "Uzbeko", native: "Oʻzbekcha", flag: "🇺🇿", stt: true, tts: false },
  { code: "cy", label: "Welsh", labelEs: "Galés", native: "Cymraeg", flag: "🏴󠁧󠁢󠁷󠁬󠁳󠁿", stt: true, tts: false },
  { code: "yi", label: "Yiddish", labelEs: "Yidis", native: "ייִדיש", flag: "🌐", stt: true, tts: false },
  { code: "yo", label: "Yoruba", labelEs: "Yoruba", native: "Yorùbá", flag: "🇳🇬", stt: true, tts: false },
] as const satisfies readonly LanguageShape[];

/** Every language TAOS knows — the union, so a typo is a compile error. */
export type LanguageCode = (typeof CATALOG)[number]["code"];

export interface Language extends LanguageShape {
  code: LanguageCode;
}

export const LANGUAGES: readonly Language[] = CATALOG;

const BY_CODE: ReadonlyMap<string, Language> = new Map(
  LANGUAGES.map((language) => [language.code, language])
);

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && BY_CODE.has(value);
}

export function getLanguage(code: string): Language | undefined {
  return BY_CODE.get(code);
}

/** ENGLISH name, the one the prompts name to the model. */
export function languageLabel(code: string): string {
  return BY_CODE.get(code)?.label ?? code.toUpperCase();
}

/** SPANISH name, so a line can be framed for Liz the way `label` is for Tom. */
export function languageLabelEs(code: string): string {
  return BY_CODE.get(code)?.labelEs ?? code.toUpperCase();
}

/** The language's own name — what a person looks for on the picker. */
export function languageNative(code: string): string {
  return BY_CODE.get(code)?.native ?? code.toUpperCase();
}

export function languageFlag(code: string): string {
  return BY_CODE.get(code)?.flag ?? "🌐";
}

/**
 * Tier 1 or tier 2 — THE question /translate asks before it calls /api/tts.
 * An unknown code answers false: if we cannot say what a language is, we
 * certainly cannot promise to speak it, and text-only is the safe failure.
 */
export function canSpeak(code: string): boolean {
  return BY_CODE.get(code)?.tts === true;
}

/** Tier 1 only — the languages a turn can come back out loud in. */
export const SPEAKABLE_LANGUAGES: readonly Language[] = LANGUAGES.filter((l) => l.tts);

// ── The picker's order ─────────────────────────────────────────────────────
// Ranked languages first, in rank order; then everything else alphabetical by
// English name. Alphabetical by ENGLISH (not native) because the list is one
// column of mixed scripts and English is the only ordering both readers of
// this app share — searching is how you find 中文, not scrolling to it.
export const SHEET_LANGUAGES: readonly Language[] = [...LANGUAGES].sort((a, b) => {
  if (a.rank && b.rank) return a.rank - b.rank;
  if (a.rank) return -1;
  if (b.rank) return 1;
  return a.label.localeCompare(b.label, "en");
});

// ── Search ────────────────────────────────────────────────────────────────
// Diacritics are stripped on both sides so "frances" finds Francés and
// "espanol" finds Español — nobody long-presses a phone key to reach an accent
// while a waiter waits. Non-Latin scripts fall through unchanged, which is
// what makes typing 中 or ру work.
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks left behind by NFD
    .toLowerCase()
    .trim();
}

/**
 * Languages matching `query`, best first: the exact code, then names that
 * START with it, then names that merely contain it. Ties keep SHEET_LANGUAGES'
 * order, so a blank box is the plain ranked list and "por" puts Portuguese
 * above Singapore-adjacent accidents.
 *
 * Matched across all four names — native, English, Spanish, and the code —
 * because the person reaching for a language may be the one who speaks it
 * (they will type 中文), the phone's owner (Chinese), or Liz (Chino).
 */
export function searchLanguages(query: string): readonly Language[] {
  const q = fold(query);
  if (!q) return SHEET_LANGUAGES;

  const scored: Array<{ language: Language; score: number }> = [];
  for (const language of SHEET_LANGUAGES) {
    if (language.code === q) {
      scored.push({ language, score: 0 });
      continue;
    }
    const names = [language.native, language.label, language.labelEs, language.code].map(fold);
    if (names.some((n) => n.startsWith(q))) {
      scored.push({ language, score: 1 });
      continue;
    }
    if (names.some((n) => n.includes(q))) {
      scored.push({ language, score: 2 });
    }
  }
  // Stable sort (ES2019+) — equal scores keep the SHEET_LANGUAGES order above.
  return scored.sort((a, b) => a.score - b.score).map((s) => s.language);
}
