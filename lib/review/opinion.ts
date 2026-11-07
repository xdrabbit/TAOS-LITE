// The second opinion on a review turn (Tom, 2026-11-04 20:27 MT): a model
// checks each kept turn — the transcription and the A→B translation — so the
// founders can verify the SUSPECTS by ear instead of reading every row.
//
// This module is the pure half: the word diff and its agreement ratio, the
// grader's JSON contract and its strict parse, the one number the page sorts
// by, and the knobs. No node: imports and no network, so the page, the routes
// and the tests read one definition. The server half — fetching the clip,
// calling the transcriber and the grader, writing the row — is
// lib/review/secondOpinion.ts.
//
// ── The rule that matters ──────────────────────────────────────────────────
// A grader's issue NEVER sets a flag. It highlights. Humans flag. Nothing in
// this module writes flag_reason, and the store's save path cannot either.

import { isSupportedLanguageCode } from "@/lib/realtime/languages";

// ── Knobs ──────────────────────────────────────────────────────────────────

/**
 * The second transcriber. whisper-1 by default: a different family from the
 * gpt-4o-transcribe every mic uses, which is the point of a second opinion.
 * It retires 2026-02-26 per OpenAI's deprecation page, so it is a knob, not a
 * constant — set TAOS_REVIEW_STT_MODEL when it goes.
 */
export const REVIEW_STT_MODEL_DEFAULT = "whisper-1";

export function reviewSttModel(raw: string | undefined = process.env.TAOS_REVIEW_STT_MODEL): string {
  const v = (raw ?? "").trim();
  return v || REVIEW_STT_MODEL_DEFAULT;
}

/**
 * The transcriber to use for THIS turn: the configured one, unless that is
 * exactly what produced the turn — then the next different one, so the
 * second opinion is never the same model reading the same clip twice.
 */
export const REVIEW_STT_FALLBACKS = ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"] as const;

export function pickAltSttModel(turnModel: string | null | undefined, preferred: string = reviewSttModel()): string {
  const used = (turnModel ?? "").trim().toLowerCase();
  if (preferred.trim().toLowerCase() !== used) return preferred;
  return REVIEW_STT_FALLBACKS.find((m) => m !== used) ?? preferred;
}

/** How many turns one "check all" click may send. Default 50, never above 200. */
export const REVIEW_BATCH_MAX_DEFAULT = 50;

export function reviewBatchMax(raw: string | undefined = process.env.TAOS_REVIEW_BATCH_MAX): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return REVIEW_BATCH_MAX_DEFAULT;
  return Math.min(200, n);
}

/** The opt-in nightly batch. Off unless TAOS_REVIEW_NIGHTLY=1. */
export function reviewNightlyEnabled(raw: string | undefined = process.env.TAOS_REVIEW_NIGHTLY): boolean {
  return (raw ?? "").trim() === "1";
}

/** The language the grader writes its one-line reasons in: the reviewer's, else English. */
export function explainLanguage(raw: unknown): string {
  return typeof raw === "string" && isSupportedLanguageCode(raw) ? raw : "en";
}

/** "Check all" is capped at ONE day's turns: a window wider than this is refused. */
export const REVIEW_BATCH_WINDOW_MAX_MS = 36 * 60 * 60 * 1000;

// ── The shape stored on the row ────────────────────────────────────────────

export const ISSUE_KINDS = ["dropped", "invented", "wrong-word", "wrong-register", "other"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export interface GradeIssue {
  /** The words in question, quoted from the translation (or the source, when dropped). */
  span: string;
  kind: IssueKind;
  /** One line. */
  why: string;
}

export interface ReviewGrade {
  model: string;
  /** 1..5 — 5 means the same meaning, nothing dropped or invented. */
  meaning: number;
  /** 1..5 — 5 means the register, politeness and warmth survived. */
  tone: number;
  issues: GradeIssue[];
  suggested_translation: string;
}

export interface DiffSpan {
  /** Character offsets into the ORIGINAL transcript. start === end is an insertion. */
  start: number;
  end: number;
  /** What the original says there. */
  original: string;
  /** What the second transcriber heard instead ("" when it heard nothing). */
  alt: string;
}

export interface ReviewStt {
  model: string;
  alt_transcript: string;
  /** 0..1 — matched words over the longer of the two. */
  agreement: number;
  diff: DiffSpan[];
}

export interface ReviewOpinion {
  stt: ReviewStt | null;
  grade: ReviewGrade | null;
  /** Codes only, never messages. */
  errors: { stt?: string; grade?: string };
}

// ── The word diff ──────────────────────────────────────────────────────────
// Words are runs of letters and digits (any script), with an apostrophe
// allowed inside ("don't", "l'eau"); punctuation and case are not words and
// do not count as differences — "¿Cómo estás?" and "como estas" differ on
// the accents only, which IS a difference a transcriber can get wrong.

export interface Token {
  /** As written. */
  text: string;
  /** Lowercased, for comparing. */
  norm: string;
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD)) {
    const start = m.index ?? 0;
    out.push({ text: m[0], norm: m[0].toLowerCase(), start, end: start + m[0].length });
  }
  return out;
}

export interface WordDiff {
  agreement: number;
  matched: number;
  spans: DiffSpan[];
}

/**
 * Diff `alt` against `original` word by word (longest common subsequence),
 * and group every run of unmatched words into one span, placed in the
 * ORIGINAL's characters so the page can highlight the transcript it shows.
 */
export function wordDiff(original: string, alt: string): WordDiff {
  const a = tokenize(original);
  const b = tokenize(alt);
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return { agreement: 1, matched: 0, spans: [] };

  // LCS table, bottom-up. Transcripts are at most a few hundred words.
  const lcs: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) lcs.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i].norm === b[j].norm ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const spans: DiffSpan[] = [];
  let matched = 0;
  let i = 0;
  let j = 0;
  // A run of unmatched tokens on either side, waiting to be closed.
  let runA: Token[] = [];
  let runB: Token[] = [];
  const close = (): void => {
    if (runA.length === 0 && runB.length === 0) return;
    const start = runA.length > 0 ? runA[0].start : a[i]?.start ?? original.length;
    const end = runA.length > 0 ? runA[runA.length - 1].end : start;
    spans.push({
      start,
      end,
      original: runA.length > 0 ? original.slice(start, end) : "",
      alt: runB.map((t) => t.text).join(" ")
    });
    runA = [];
    runB = [];
  };
  while (i < n && j < m) {
    if (a[i].norm === b[j].norm) {
      close();
      matched += 1;
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      runA.push(a[i]);
      i += 1;
    } else {
      runB.push(b[j]);
      j += 1;
    }
  }
  while (i < n) runA.push(a[i++]);
  while (j < m) runB.push(b[j++]);
  close();

  const agreement = matched / Math.max(n, m);
  return { agreement: Math.round(agreement * 1000) / 1000, matched, spans };
}

// ── The grader's contract ──────────────────────────────────────────────────

/** Strict JSON schema for the chat completions `response_format`. */
export const REVIEW_GRADE_SCHEMA = {
  name: "translation_grade",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["meaning", "tone", "issues", "suggested_translation"],
    properties: {
      meaning: { type: "integer", minimum: 1, maximum: 5 },
      tone: { type: "integer", minimum: 1, maximum: 5 },
      issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["span", "kind", "why"],
          properties: {
            span: { type: "string" },
            kind: { type: "string", enum: [...ISSUE_KINDS] },
            why: { type: "string" }
          }
        }
      },
      suggested_translation: { type: "string" }
    }
  }
} as const;

export interface GradePromptInput {
  source: string;
  translation: string;
  sourceLabel: string;
  targetLabel: string;
  /** The language the one-line "why"s are written in. */
  explainLabel: string;
}

export function buildGradePrompt(input: GradePromptInput): { system: string; user: string } {
  const system = [
    `You are a strict bilingual reviewer of a LIVE SPOKEN translation from ${input.sourceLabel} to ${input.targetLabel}.`,
    "The source is a verbatim speech transcript: it may be casual, unfinished, or carry disfluencies, and that is not a fault.",
    "Grade the translation ONLY against the source. Answer in JSON matching the schema.",
    "meaning: 1-5. 5 = the same meaning, nothing dropped, nothing invented. 1 = a different message.",
    "tone: 1-5. 5 = the register, politeness, formality and warmth survived. 1 = a different person is speaking.",
    "issues: every concrete problem, each with the exact span (quoted from the translation, or from the source when something was dropped),",
    "a kind (dropped, invented, wrong-word, wrong-register, other), and one line of why.",
    `Write every "why" in ${input.explainLabel}. Do not list style preferences as issues; an issue is something a listener would be misled by.`,
    `suggested_translation: the corrected full translation in ${input.targetLabel}, or the given translation unchanged when it is fine.`
  ].join("\n");
  const user = `SOURCE (${input.sourceLabel}):\n${input.source}\n\nTRANSLATION (${input.targetLabel}):\n${input.translation}`;
  return { system, user };
}

export const GRADE_SPAN_MAX = 200;
export const GRADE_WHY_MAX = 300;
export const GRADE_ISSUES_MAX = 10;
export const GRADE_SUGGESTION_MAX = 2000;

export type ParsedGrade = { ok: true; grade: Omit<ReviewGrade, "model"> } | { ok: false; code: "malformed" | "empty" };

function clampScore(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(1, Math.round(n)));
}

function clip(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * Parse the grader's reply. Strict on the two scores (no number → the whole
 * reply is malformed), forgiving on the rest (an unknown kind becomes
 * "other"; over-long text is clipped; a non-array issues list is empty).
 * Never throws: a malformed reply is a code the row keeps, not a crash.
 */
export function parseGrade(content: string): ParsedGrade {
  const text = (content ?? "").trim();
  if (!text) return { ok: false, code: "empty" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Some models wrap JSON in a fence; take the first object if there is one.
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return { ok: false, code: "malformed" };
    try {
      raw = JSON.parse(m[0]);
    } catch {
      return { ok: false, code: "malformed" };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "malformed" };
  const r = raw as Record<string, unknown>;
  const meaning = clampScore(r.meaning);
  const tone = clampScore(r.tone);
  if (meaning === null || tone === null) return { ok: false, code: "malformed" };
  const issues: GradeIssue[] = (Array.isArray(r.issues) ? r.issues : [])
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
    .slice(0, GRADE_ISSUES_MAX)
    .map((x) => ({
      span: clip(x.span, GRADE_SPAN_MAX),
      kind: (ISSUE_KINDS as readonly string[]).includes(String(x.kind)) ? (x.kind as IssueKind) : "other",
      why: clip(x.why, GRADE_WHY_MAX)
    }))
    .filter((x) => x.span || x.why);
  return {
    ok: true,
    grade: { meaning, tone, issues, suggested_translation: clip(r.suggested_translation, GRADE_SUGGESTION_MAX) }
  };
}

// ── The one number the page sorts by ───────────────────────────────────────

/**
 * The lowest of agreement, meaning/5 and tone/5 among the halves that
 * arrived, in 0..1. Null when nothing arrived: a turn whose check failed
 * twice is unreviewed, not innocent.
 */
export function opinionScore(opinion: ReviewOpinion | null | undefined): number | null {
  if (!opinion) return null;
  const parts: number[] = [];
  if (opinion.stt && Number.isFinite(opinion.stt.agreement)) parts.push(opinion.stt.agreement);
  if (opinion.grade) parts.push(opinion.grade.meaning / 5, opinion.grade.tone / 5);
  if (parts.length === 0) return null;
  return Math.round(Math.min(...parts) * 1000) / 1000;
}

export interface Sortable {
  opinion_score: number | null;
  created_at: string;
}

/**
 * Suspects first: checked turns by rising score (the worst at the top), ties
 * newest first; then the unchecked, newest first. The store orders the same
 * way in SQL; this is the one definition the test pins and the page can fall
 * back on.
 */
export function sortSuspectsFirst<T extends Sortable>(rows: readonly T[]): T[] {
  return [...rows].sort((x, y) => {
    const xs = x.opinion_score;
    const ys = y.opinion_score;
    if (xs === null && ys !== null) return 1;
    if (xs !== null && ys === null) return -1;
    if (xs !== null && ys !== null && xs !== ys) return xs - ys;
    return Date.parse(y.created_at) - Date.parse(x.created_at);
  });
}

/** Does this opinion deserve a founder's ear? Below this, the row is drawn as a suspect. */
export const SUSPECT_SCORE = 0.8;

export function isSuspect(score: number | null | undefined): boolean {
  return typeof score === "number" && score < SUSPECT_SCORE;
}
