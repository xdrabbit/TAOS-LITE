import type { Lesson } from "./lesson.d.mts";

export interface LessonSourceRecord {
  id?: string | null;
  key?: number;
  source_table?: string | null;
  created_at?: string | null;
  created_ms?: number | null;
  source_lang?: string | null;
  target_lang?: string | null;
  original_text?: string;
  translation_text?: string;
}

export interface SavedLesson {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  model: string;
  usage: Record<string, number> | null;
  selection: string;
  sources: Array<{
    identity: string;
    id: string | null;
    source_table: string | null;
    created_at: string | null;
    source_lang: string | null;
    target_lang: string | null;
    original_text: string;
    translation_text: string;
  }>;
  note: string;
  tags: string[];
  lesson: Lesson;
}

export interface LessonSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  title: string;
  english: string;
  sentenceCount: number;
  language: string;
  note: string;
  tags: string[];
  sourceAt: string | null;
}

export declare function recordIdentity(record: LessonSourceRecord): string;
export declare function lessonId(records: LessonSourceRecord[], selection?: string): string;
export declare function summary(saved: SavedLesson): LessonSummary;
export declare function newSavedLesson(input: {
  id: string;
  lesson: unknown;
  model: string;
  records: LessonSourceRecord[];
  selection?: string;
  usage?: Record<string, number> | null;
}): SavedLesson;

export declare class LessonStore {
  constructor(dir: string);
  readonly dir: string;
  get(id: string): Promise<SavedLesson | null>;
  put(saved: SavedLesson): Promise<SavedLesson>;
  update(id: string, changes: { note?: string; tags?: string[] }): Promise<SavedLesson | null>;
  remove(id: string): Promise<boolean>;
  list(): Promise<LessonSummary[]>;
}
