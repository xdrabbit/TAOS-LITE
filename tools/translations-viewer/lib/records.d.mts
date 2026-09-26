export interface TranslationRecord {
  id: string | null;
  source_table: string | null;
  created_at: string | null;
  created_ms: number | null;
  user_id: string | null;
  source_lang: string | null;
  target_lang: string | null;
  tone: string | null;
  engine: string | null;
  original_text: string;
  translation_text: string;
  extra: Record<string, unknown>;
}

export interface Tally {
  value: string;
  count: number;
}

export interface Summary {
  total: number;
  users: number;
  firstAt: string | null;
  lastAt: string | null;
  sourceLangs: Tally[];
  targetLangs: Tally[];
  engines: Tally[];
  tables: Tally[];
}

export interface ParsedExport {
  manifest: Record<string, unknown> | null;
  records: TranslationRecord[];
  skipped: Array<{ line: number; reason: string }>;
}

export declare const TRANSLATIONS_TABLE: string;
export declare const CHAT_TABLE: string;
export declare const TRANSLATION_COLUMNS: string[];
export declare function fromTranslationRow(row: Record<string, unknown>): TranslationRecord;
export declare function fromChatRow(row: Record<string, unknown>): TranslationRecord;
export declare function fromExportRecord(
  record: Record<string, unknown>,
  sourceTable?: string
): TranslationRecord;
export declare function parseExport(text: string): ParsedExport;
export declare function parseCsv(text: string): string[][];
export declare function dedupe(recordSets: TranslationRecord[][]): {
  records: TranslationRecord[];
  duplicates: number;
};
export declare function summarise(records: TranslationRecord[]): Summary;
