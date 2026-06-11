import type { SourceLanguageCode, SupportedLanguageCode } from "./languages";

export type ConnectionState =
  | "idle"
  | "requesting_mic"
  | "requesting_session"
  | "connecting"
  | "connected"
  | "stopping"
  | "error";

export interface TranslationSessionPayload {
  callUrl: string;
  clientSecret: string;
  expiresAt?: number;
  model: string;
  sourceHintApplied: boolean;
  sourceLanguage: SourceLanguageCode;
  targetLanguage: SupportedLanguageCode;
  warnings: string[];
}

export type RawRealtimeEvent = Record<string, unknown>;
