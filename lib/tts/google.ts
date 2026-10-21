import type { TtsLangCode } from "./voice";

export type GoogleTtsTier = "standard" | "wavenet" | "neural2";

export interface GoogleVoice {
  languageCode: string;
  voiceName: string;
}

type VoiceNames = Record<GoogleTtsTier, string>;

interface GoogleVoiceRow {
  languageCode: string;
  voices: VoiceNames;
}

/**
 * One female Google voice for every TAOS spoken language Google covers in the
 * three selectable families. Some languages do not have all three families;
 * those entries repeat the best available lower-cost voice so changing the
 * tier never makes a language that Google can speak disappear.
 *
 * Verified against Google's public voice list on 2026-10-21. Croatian has no
 * Standard/WaveNet/Neural2 voice, and Bosnian's catalog hint is Croatian, so
 * both are deliberately absent and take the existing text-only response.
 */
const GOOGLE_VOICES: Partial<Record<TtsLangCode, GoogleVoiceRow>> = {
  en: voices("en-US", "en-US-Standard-F", "en-US-Wavenet-F", "en-US-Neural2-F"),
  es: voices("es-US", "es-US-Standard-A", "es-US-Wavenet-A", "es-US-Neural2-A"),
  zh: voices("cmn-CN", "cmn-CN-Standard-A", "cmn-CN-Wavenet-A", "cmn-CN-Wavenet-A"),
  hi: voices("hi-IN", "hi-IN-Standard-A", "hi-IN-Wavenet-A", "hi-IN-Neural2-A"),
  ar: voices("ar-XA", "ar-XA-Standard-A", "ar-XA-Wavenet-A", "ar-XA-Wavenet-A"),
  pt: voices("pt-PT", "pt-PT-Standard-E", "pt-PT-Wavenet-E", "pt-PT-Wavenet-E"),
  ru: voices("ru-RU", "ru-RU-Standard-A", "ru-RU-Wavenet-A", "ru-RU-Wavenet-A"),
  ja: voices("ja-JP", "ja-JP-Standard-B", "ja-JP-Wavenet-B", "ja-JP-Neural2-B"),
  de: voices("de-DE", "de-DE-Standard-G", "de-DE-Wavenet-G", "de-DE-Neural2-G"),
  fr: voices("fr-FR", "fr-FR-Standard-F", "fr-FR-Wavenet-F", "fr-FR-Neural2-F"),
  it: voices("it-IT", "it-IT-Standard-E", "it-IT-Wavenet-E", "it-IT-Neural2-E"),
  ko: voices("ko-KR", "ko-KR-Standard-A", "ko-KR-Wavenet-A", "ko-KR-Neural2-A"),
  tr: voices("tr-TR", "tr-TR-Standard-A", "tr-TR-Wavenet-A", "tr-TR-Wavenet-A"),
  vi: voices("vi-VN", "vi-VN-Standard-A", "vi-VN-Wavenet-A", "vi-VN-Neural2-A"),
  pl: voices("pl-PL", "pl-PL-Standard-F", "pl-PL-Wavenet-F", "pl-PL-Wavenet-F"),
  nl: voices("nl-NL", "nl-NL-Standard-F", "nl-NL-Wavenet-F", "nl-NL-Wavenet-F"),
  id: voices("id-ID", "id-ID-Standard-A", "id-ID-Wavenet-A", "id-ID-Wavenet-A"),
  uk: voices("uk-UA", "uk-UA-Standard-B", "uk-UA-Wavenet-B", "uk-UA-Wavenet-B"),
  bg: voices("bg-BG", "bg-BG-Standard-B", "bg-BG-Standard-B", "bg-BG-Standard-B"),
  yue: voices("yue-HK", "yue-HK-Standard-A", "yue-HK-Standard-A", "yue-HK-Standard-A"),
  cs: voices("cs-CZ", "cs-CZ-Standard-B", "cs-CZ-Wavenet-B", "cs-CZ-Wavenet-B"),
  da: voices("da-DK", "da-DK-Standard-F", "da-DK-Wavenet-F", "da-DK-Neural2-F"),
  tl: voices("fil-PH", "fil-PH-Standard-A", "fil-PH-Wavenet-A", "fil-ph-Neural2-A"),
  fi: voices("fi-FI", "fi-FI-Standard-B", "fi-FI-Wavenet-B", "fi-FI-Wavenet-B"),
  el: voices("el-GR", "el-GR-Standard-B", "el-GR-Wavenet-B", "el-GR-Wavenet-B"),
  hu: voices("hu-HU", "hu-HU-Standard-B", "hu-HU-Wavenet-B", "hu-HU-Wavenet-B"),
  ms: voices("ms-MY", "ms-MY-Standard-A", "ms-MY-Wavenet-A", "ms-MY-Wavenet-A"),
  no: voices("nb-NO", "nb-NO-Standard-F", "nb-NO-Wavenet-F", "nb-NO-Wavenet-F"),
  ro: voices("ro-RO", "ro-RO-Standard-B", "ro-RO-Wavenet-B", "ro-RO-Wavenet-B"),
  sk: voices("sk-SK", "sk-SK-Standard-B", "sk-SK-Wavenet-B", "sk-SK-Wavenet-B"),
  sv: voices("sv-SE", "sv-SE-Standard-A", "sv-SE-Wavenet-A", "sv-SE-Wavenet-A"),
  ta: voices("ta-IN", "ta-IN-Standard-A", "ta-IN-Wavenet-A", "ta-IN-Wavenet-A")
};

function voices(
  languageCode: string,
  standard: string,
  wavenet: string,
  neural2: string
): GoogleVoiceRow {
  return { languageCode, voices: { standard, wavenet, neural2 } };
}

export function googleTtsTier(value = process.env.GOOGLE_TTS_TIER): GoogleTtsTier {
  const tier = value?.trim().toLowerCase();
  return tier === "standard" || tier === "neural2" ? tier : "wavenet";
}

export function googleVoiceFor(
  language: TtsLangCode | undefined,
  tier = googleTtsTier()
): GoogleVoice | null {
  if (!language) return null;
  const row = GOOGLE_VOICES[language];
  if (!row) return null;
  return { languageCode: row.languageCode, voiceName: row.voices[tier] };
}

export const GOOGLE_TTS_TIMEOUT_MS = 8000;

/** Call Google's synchronous REST endpoint without putting the key in the URL. */
export function synthesizeGoogle(
  text: string,
  voice: GoogleVoice,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  return fetchImpl("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: voice.languageCode, name: voice.voiceName },
      audioConfig: { audioEncoding: "MP3" }
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(GOOGLE_TTS_TIMEOUT_MS)
  });
}

export function decodeGoogleAudio(audioContent: unknown): ArrayBuffer | null {
  if (typeof audioContent !== "string" || !audioContent) return null;
  const decoded = Buffer.from(audioContent, "base64");
  if (decoded.byteLength === 0) return null;
  return decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer;
}
