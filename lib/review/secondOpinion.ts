// The second opinion, server half (Tom, 2026-11-04 20:27 MT). For one kept
// turn: fetch its clip, have a DIFFERENT transcriber read it, word-diff that
// against the transcript the turn shipped with; and have a strong text model
// grade the translation against the transcript in strict JSON. Write both on
// the row (lib/review/store.ts saveReviewOpinion — the three opinion columns
// and nothing else). The pure half — the diff, the parse, the score, the
// knobs — is lib/review/opinion.ts.
//
// ── Who pays, and when ─────────────────────────────────────────────────────
// Never on a turn's own path. Only from /api/review/opinion (one turn, one
// tap), /api/review/opinion/batch (a day's unreviewed turns, capped per
// click by TAOS_REVIEW_BATCH_MAX), and — off by default — the nightly pass
// the walkie cron runs when TAOS_REVIEW_NIGHTLY=1. All three stand behind
// guardReview (guardSpend first, then founders only).
//
// ── Privacy ────────────────────────────────────────────────────────────────
// The transcript and the translation go to the model provider, exactly as
// translating already sends them. Logs carry counts and codes only.

import { STUDY_LESSON_MODEL_DEFAULT } from "@/lib/study/lesson";
import { getLanguageLabel, isSupportedLanguageCode } from "@/lib/realtime/languages";
import { transcribeAudio } from "@/lib/translate/transcribe";
import {
  buildGradePrompt,
  opinionScore,
  parseGrade,
  pickAltSttModel,
  reviewBatchMax,
  REVIEW_GRADE_SCHEMA,
  wordDiff,
  type ReviewOpinion
} from "./opinion";
import {
  downloadReviewAudio,
  listReviewTurns,
  readReviewTurn,
  saveReviewOpinion,
  ReviewStoreError,
  type ReviewListFilter,
  type ReviewTurnRow
} from "./store";

/**
 * The grader. The strongest OpenAI text model the repo already runs
 * (lib/study/lesson.ts: gpt-5.5, chosen there because gpt-4.1 marked
 * flexible word orders as mistakes). TAOS_REVIEW_GRADER_MODEL overrides.
 * No temperature is ever sent: reasoning models reject it.
 */
export function reviewGraderModel(raw: string | undefined = process.env.TAOS_REVIEW_GRADER_MODEL): string {
  return (raw ?? "").trim() || STUDY_LESSON_MODEL_DEFAULT;
}

/** A clip re-read is one phrase to five minutes; the grade is one short JSON. */
export const OPINION_STT_TIMEOUT_MS = 90_000;
export const OPINION_GRADE_TIMEOUT_MS = 90_000;

export interface OpinionDeps {
  apiKey: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

function label(code: string): string {
  return isSupportedLanguageCode(code) ? getLanguageLabel(code) : code;
}

function errorCode(error: unknown): string {
  if (error instanceof ReviewStoreError) return error.code;
  if (error && typeof error === "object" && "upstreamStatus" in error) {
    return `http_${String((error as { upstreamStatus: unknown }).upstreamStatus)}`;
  }
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  return "failed";
}

function extFor(mime: string | null): string {
  const m = mime ?? "";
  if (m.includes("mp4") || m.includes("aac") || m.includes("m4a")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  return "webm";
}

// ── The two halves ─────────────────────────────────────────────────────────

async function secondTranscript(row: ReviewTurnRow, deps: OpinionDeps): Promise<ReviewOpinion["stt"]> {
  const model = pickAltSttModel(row.transcribe_model);
  const bytes = await downloadReviewAudio(row.audio_path);
  const mime = row.audio_mime || "audio/webm";
  const file = new File([bytes as BlobPart], `clip.${extFor(mime)}`, { type: mime });
  // A manual turn knows its language; an auto turn did not, and the second
  // reader gets the same freedom the first one had.
  const sourceLabel = row.mode === "auto" ? undefined : label(row.source_lang);
  const alt = await transcribeAudio(deps.apiKey, file, { sourceLabel, model, timeoutMs: OPINION_STT_TIMEOUT_MS });
  const diff = wordDiff(row.original_text, alt);
  return { model, alt_transcript: alt, agreement: diff.agreement, diff: diff.spans };
}

async function gradeTranslation(row: ReviewTurnRow, deps: OpinionDeps, explain: string): Promise<ReviewOpinion["grade"]> {
  const model = reviewGraderModel();
  const prompt = buildGradePrompt({
    source: row.original_text,
    translation: row.translation_text,
    sourceLabel: label(row.source_lang),
    targetLabel: label(row.target_lang),
    explainLabel: label(explain)
  });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      // No temperature, on purpose: Luna-class / reasoning models reject it.
      response_format: { type: "json_schema", json_schema: REVIEW_GRADE_SCHEMA },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ]
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(OPINION_GRADE_TIMEOUT_MS)
  });
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw Object.assign(new Error("grader refused"), { upstreamStatus: res.status });
  const first = (Array.isArray(payload?.choices) ? payload?.choices : [])[0] as Record<string, unknown> | undefined;
  const message = (first?.message ?? {}) as Record<string, unknown>;
  if (message.refusal) throw Object.assign(new Error("grader declined"), { upstreamStatus: 200 });
  const parsed = parseGrade(typeof message.content === "string" ? message.content : "");
  if (!parsed.ok) throw new ReviewStoreError("grader reply unusable", `grade_${parsed.code}`);
  return { model, ...parsed.grade };
}

export interface OpinionOutcome {
  opinion: ReviewOpinion;
  score: number | null;
  ms: number;
}

/** Both halves, in parallel, each failing on its own. Never throws. */
export async function secondOpinionFor(row: ReviewTurnRow, deps: OpinionDeps, explain = "en"): Promise<OpinionOutcome> {
  const started = Date.now();
  const [stt, grade] = await Promise.allSettled([secondTranscript(row, deps), gradeTranslation(row, deps, explain)]);
  const opinion: ReviewOpinion = {
    stt: stt.status === "fulfilled" ? stt.value : null,
    grade: grade.status === "fulfilled" ? grade.value : null,
    errors: {
      ...(stt.status === "rejected" ? { stt: errorCode(stt.reason) } : {}),
      ...(grade.status === "rejected" ? { grade: errorCode(grade.reason) } : {})
    }
  };
  const score = opinionScore(opinion);
  const ms = Date.now() - started;
  console.log(
    `[taos-review] opinion stt=${opinion.stt?.model ?? "-"} grader=${opinion.grade?.model ?? "-"}` +
      ` agreement=${opinion.stt ? opinion.stt.agreement : "?"} meaning=${opinion.grade?.meaning ?? "?"}` +
      ` tone=${opinion.grade?.tone ?? "?"} issues=${opinion.grade?.issues.length ?? "?"}` +
      ` score=${score ?? "?"} err_stt=${opinion.errors.stt ?? "-"} err_grade=${opinion.errors.grade ?? "-"} ms=${ms}`
  );
  return { opinion, score, ms };
}

/**
 * One turn, by id: read, check, save. Null when the turn is gone (expired or
 * never existed). Throws a ReviewStoreError when the database does.
 */
export async function runSecondOpinion(id: string, deps: OpinionDeps, explain = "en"): Promise<ReviewTurnRow | null> {
  const nowMs = deps.nowMs ?? Date.now();
  const row = await readReviewTurn(id, nowMs);
  if (!row) return null;
  const outcome = await secondOpinionFor(row, deps, explain);
  return saveReviewOpinion(row.id, outcome.opinion, outcome.score, Date.now());
}

export interface BatchResult {
  checked: number;
  failed: number;
  /** More unreviewed turns matched than this pass took. */
  more: boolean;
}

/**
 * Every unreviewed turn the filter matches, at most `limit`, a few at a
 * time. A turn whose both halves failed counts as failed and stays
 * unreviewed (opinion_at is still written, so a broken clip is not retried
 * forever by the nightly pass — the page's per-row button re-checks it).
 */
export async function runOpinionBatch(
  filter: ReviewListFilter,
  deps: OpinionDeps,
  limit: number = reviewBatchMax(),
  explain = "en",
  concurrency = 3
): Promise<BatchResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const rows = await listReviewTurns({ ...filter, unreviewedOnly: true, sort: "newest" }, nowMs, limit + 1);
  const batch = rows.slice(0, limit);
  const result: BatchResult = { checked: 0, failed: 0, more: rows.length > limit };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batch.length) {
      const row = batch[next++];
      try {
        const outcome = await secondOpinionFor(row, deps, explain);
        await saveReviewOpinion(row.id, outcome.opinion, outcome.score, Date.now());
        if (outcome.score === null) result.failed += 1;
        else result.checked += 1;
      } catch (error) {
        result.failed += 1;
        console.error(`[taos-review] opinion_save_failed code=${errorCode(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));
  return result;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The opt-in nightly pass: the last day's unreviewed turns, one batch's worth. */
export async function runNightlyOpinions(deps: OpinionDeps): Promise<BatchResult> {
  const nowMs = deps.nowMs ?? Date.now();
  return runOpinionBatch({ fromIso: new Date(nowMs - DAY_MS).toISOString() }, deps, reviewBatchMax(), "en", 2);
}
