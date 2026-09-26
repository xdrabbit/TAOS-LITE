import type { Summary, TranslationRecord } from "./records.d.mts";

export interface SearchOptions {
  match?: string | null;
  limit?: number;
  offset?: number;
  order?: "newest" | "oldest" | "relevance";
  fromMs?: number | null;
  toMs?: number | null;
  sourceLang?: string;
  targetLang?: string;
  engine?: string;
  table?: string;
  userId?: string;
}

export interface SearchRow extends TranslationRecord {
  key: number;
  original_snippet?: string;
  translation_snippet?: string;
}

export interface ContextRow extends TranslationRecord {
  key: number;
  original_marked?: string;
  translation_marked?: string;
}

export interface ContextResult {
  key: number;
  scope: "user" | "no-user";
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  rows: ContextRow[];
}

export declare function buildMatchQuery(
  input: string | null | undefined,
  options?: { raw?: boolean }
): string | null;

export declare function parseDateBound(
  value: string | null | undefined,
  options?: { endOfDay?: boolean }
): number | null;

export declare class TranslationIndex {
  readonly summary: Summary;
  readonly manifest: Record<string, unknown> | null;
  readonly source: { kind: string; file?: string; url?: string };
  readonly skipped: Array<{ line: number; reason: string }>;
  readonly loadedAt: string;
  static build(input: {
    records: TranslationRecord[];
    manifest?: Record<string, unknown> | null;
    source: { kind: string; file?: string; url?: string };
    skipped?: Array<{ line: number; reason: string }>;
    log?: (message: string) => void;
  }): Promise<TranslationIndex>;
  search(options?: SearchOptions): { total: number; rows: SearchRow[] };
  all(options?: SearchOptions): SearchRow[];
  context(
    key: number,
    options?: { before?: number; after?: number; match?: string | null }
  ): ContextResult | null;
  close(): void;
}
