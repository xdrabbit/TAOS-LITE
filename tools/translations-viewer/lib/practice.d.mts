export interface ScoredWord {
  word: string;
  accuracy: number | null;
  errorType: string | null;
}

export interface Assessment {
  status: string;
  transcript: string;
  accuracy: number | null;
  fluency: number | null;
  completeness: number | null;
  pron: number | null;
  words: ScoredWord[];
}

export declare function azureLocale(lang: string): string | null;
export declare function describeScoring(input: { key?: string; region?: string }): {
  available: boolean;
  reason: string | null;
};
export declare function parseAssessment(data: unknown): Assessment;
export declare function assessPronunciation(input: {
  key: string;
  region: string;
  wav: Buffer | Uint8Array;
  referenceText: string;
  locale: string;
  fetchImpl?: typeof fetch;
}): Promise<Assessment>;
export declare function speak(input: {
  apiKey: string;
  voiceId: string;
  text: string;
  slow?: boolean;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<Buffer>;
