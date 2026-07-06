// Hand-written types for the pure JS build core in ./model.mjs, so the TS API
// route and the client engine consume it type-safely.

export type Direction = "en-es" | "es-en";
export type Lang = "en" | "es";

/** A history row reduced to what the builder needs. */
export interface HistoryInput {
  text: string;
  createdAtMs: number;
}

/** The compact, pruned model artifact served to the client (one per direction). */
export interface PredictModel {
  direction: Direction;
  typedLang: Lang;
  rowCount: number;
  tokenCount: number;
  halfLifeDays: number;
  /** word -> recency-weighted frequency (prefix-completion pool). */
  unigrams: Record<string, number>;
  /** "w1" -> top [w2, weight] next-words. */
  bigrams: Record<string, Array<[string, number]>>;
  /** "w1 w2" -> top [w3, weight] next-words. */
  trigrams: Record<string, Array<[string, number]>>;
  /** top recurring multi-word phrases as [phrase, weight]. */
  phrases: Array<[string, number]>;
}

export const DIRECTIONS: Direction[];
export const TYPED_LANG: Record<Direction, Lang>;
export const HALF_LIFE_DAYS: number;
export const CAPS: {
  unigrams: number;
  perContext: number;
  contexts: number;
  phrases: number;
};

export function recencyWeight(createdAtMs: number, nowMs: number): number;
export function detectLang(text: string): Lang | null;
export function isJunk(text: string): boolean;
export function tokenizeSegments(text: string): string[][];
export function buildDirectionModel(
  rows: HistoryInput[],
  direction: Direction,
  nowMs: number
): PredictModel;
export function emptyModel(direction: Direction): PredictModel;
export function buildAllModels(
  rawRows: Array<{ original_text: string; created_at: string }>,
  nowMs: number
): Record<Direction, PredictModel>;
