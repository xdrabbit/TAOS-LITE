export interface LessonWord {
  text: string;
  lemma: string;
  gloss: string;
  literal: string;
  role: string;
  note: string;
}

export interface LessonSentence {
  target: string;
  as_said: string;
  english: string;
  words: LessonWord[];
  literal: string;
  english_order_trap: string;
  order_points: Array<{ rule: string; explanation: string; example: string }>;
  context_meaning: string;
  register: string;
  chunks: string[];
}

export interface Lesson {
  target_language: string;
  explain_language?: string;
  caveats: string;
  sentences: LessonSentence[];
}

export interface LessonRecord {
  key?: number;
  source_lang?: string | null;
  target_lang?: string | null;
  original_text: string;
  translation_text: string;
}

export interface LessonPrompt {
  system: string;
  user: string;
  lang: string;
  explain: string;
}

export declare const LESSON_MODEL_DEFAULT: string;
export declare const LESSON_SCHEMA: { name: string; strict: boolean; schema: Record<string, unknown> };
export declare function languageName(code: string | null | undefined): string;
export declare function languagesIn(records: LessonRecord[]): string[];
export declare function targetSide(
  record: LessonRecord,
  target?: string | null
): { lang: string; text: string; other: string; otherLang: string | null | undefined } | null;
export declare function buildLessonPrompt(input: {
  selection?: string;
  records: LessonRecord[];
  context?: LessonRecord[];
  target?: string | null;
  explain?: string;
}): LessonPrompt;
export declare function parseLesson(content: string): Lesson;
export declare const MAX_CHUNKS: number;
export declare function cleanTrap(value: unknown): string;
export declare function capChunks(chunks: string[]): string[];
export declare function generateLesson(input: {
  apiKey: string;
  model: string;
  prompt: LessonPrompt;
  fetchImpl?: typeof fetch;
}): Promise<{ lesson: Lesson; usage: Record<string, number> | null }>;
