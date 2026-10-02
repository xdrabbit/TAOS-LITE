import type { Summary, TranslationRecord } from "./records.d.mts";

export declare function escapeMarkdown(text: string | null | undefined): string;

export declare function renderMarkdown(payload: {
  manifest?: Record<string, unknown> | null;
  summary?: Summary | null;
  records: TranslationRecord[];
}): string;
