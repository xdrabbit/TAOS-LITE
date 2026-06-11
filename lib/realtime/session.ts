import type { SourceLanguageCode, SupportedLanguageCode } from "./languages";
import type { TranslationSessionPayload } from "./types";

interface BuildTranslationClientSecretRequestOptions {
  includeInputTranscription: boolean;
  includeSourceLanguageHint: boolean;
  model?: string;
  sourceLanguage: SourceLanguageCode;
  targetLanguage: SupportedLanguageCode;
  transcriptionModel?: string;
}

interface ParseTranslationSessionResponseOptions {
  callUrl: string;
  model: string;
  sourceHintApplied: boolean;
  sourceLanguage: SourceLanguageCode;
  targetLanguage: SupportedLanguageCode;
  warnings?: string[];
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function getDefaultRealtimeModel(): string {
  return process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-realtime-translate";
}

export function getDefaultRealtimeTranscriptionModel(): string {
  return process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe";
}

export function getDefaultRealtimeClientSecretsUrl(): string {
  return (
    process.env.OPENAI_REALTIME_TRANSLATION_CLIENT_SECRETS_URL ??
    "https://api.openai.com/v1/realtime/translations/client_secrets"
  );
}

export function getDefaultRealtimeCallsUrl(): string {
  return (
    process.env.OPENAI_REALTIME_TRANSLATION_CALLS_URL ??
    "https://api.openai.com/v1/realtime/translations/calls"
  );
}

export function buildTranslationClientSecretRequest(
  options: BuildTranslationClientSecretRequestOptions
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    session: {
      model: options.model ?? getDefaultRealtimeModel(),
      audio: {
        output: {
          language: options.targetLanguage
        }
      }
    }
  };

  if (options.includeInputTranscription) {
    const transcription: Record<string, unknown> = {
      model: options.transcriptionModel ?? getDefaultRealtimeTranscriptionModel()
    };

    if (options.includeSourceLanguageHint && options.sourceLanguage !== "auto") {
      transcription.language = options.sourceLanguage;
    }

    const session = request.session as Record<string, unknown>;
    const audio = session.audio as Record<string, unknown>;
    audio.input = { transcription };
  }

  return request;
}

export function parseTranslationSessionResponse(
  payload: unknown,
  options: ParseTranslationSessionResponseOptions
): TranslationSessionPayload {
  const json = readObject(payload);
  const nestedClientSecret = readObject(json?.client_secret);
  const session = readObject(json?.session);
  const clientSecret = readString(json?.value) ?? readString(nestedClientSecret?.value);

  if (!clientSecret) {
    throw new Error("OpenAI response did not include a realtime client secret.");
  }

  return {
    callUrl: options.callUrl,
    clientSecret,
    expiresAt:
      readNumber(json?.expires_at) ??
      readNumber(nestedClientSecret?.expires_at) ??
      readNumber(session?.expires_at),
    model: readString(session?.model) ?? options.model,
    sourceHintApplied: options.sourceHintApplied,
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    warnings: options.warnings ?? []
  };
}
