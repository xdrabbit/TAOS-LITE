"use client";

import type { ChromeCopy } from "@/lib/chrome/copy";
import { fill } from "@/lib/chrome/copy";
import { isSuspect, type IssueKind, type ReviewOpinion } from "@/lib/review/opinion";

// The second opinion, as the review page draws it (Tom, 2026-11-04 20:27 MT).
//
// Two pieces, one per column: the transcript with the words the second
// transcriber heard differently highlighted, and under the translation the
// grade, the issues and the suggested fix. Neither sets a flag. A grader's
// issue is a highlight; the flag buttons below stay the founder's.

const ISSUE_KEY: Record<IssueKind, keyof ChromeCopy> = {
  dropped: "reviewIssueDropped",
  invented: "reviewIssueInvented",
  "wrong-word": "reviewIssueWrongWord",
  "wrong-register": "reviewIssueWrongRegister",
  other: "reviewIssueOther"
};

/** The transcript, with every differing span marked. Plain text when unchecked. */
export function TranscriptWithDiff({ text, opinion }: { text: string; opinion: ReviewOpinion | null | undefined }): JSX.Element {
  const spans = opinion?.stt?.diff ?? [];
  if (spans.length === 0) return <p className="whitespace-pre-wrap text-base leading-snug text-amber-50">{text}</p>;
  const parts: JSX.Element[] = [];
  let cursor = 0;
  const ordered = [...spans].filter((s) => s.start >= 0 && s.end <= text.length && s.start <= s.end).sort((a, b) => a.start - b.start);
  ordered.forEach((span, i) => {
    if (span.start < cursor) return;
    if (span.start > cursor) parts.push(<span key={`t${i}`}>{text.slice(cursor, span.start)}</span>);
    if (span.end > span.start) {
      parts.push(
        <mark
          key={`m${i}`}
          data-review-diff=""
          title={span.alt ? `→ ${span.alt}` : "→ ∅"}
          className="rounded bg-amber-400/30 px-0.5 text-amber-50 underline decoration-amber-300 decoration-dotted underline-offset-4"
        >
          {text.slice(span.start, span.end)}
        </mark>
      );
    } else if (span.alt) {
      parts.push(
        <span key={`i${i}`} data-review-diff="" title={`+ ${span.alt}`} className="text-amber-300/70">
          ⟨+{span.alt}⟩
        </span>
      );
    }
    cursor = span.end;
  });
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>);
  return <p className="whitespace-pre-wrap text-base leading-snug text-amber-50">{parts}</p>;
}

function Score({ label, value }: { label: string; value: number }): JSX.Element {
  const bad = value <= 3;
  return (
    <span className={`rounded-full border px-2 py-0.5 ${bad ? "border-rose-300/50 bg-rose-500/15 text-rose-100" : "border-emerald-300/30 bg-emerald-500/10 text-emerald-100"}`}>
      {label} {value}/5
    </span>
  );
}

/** What the second transcriber heard, and the grader's reading of the translation. */
export function OpinionPanel({ opinion, score, s }: { opinion: ReviewOpinion | null | undefined; score: number | null; s: ChromeCopy }): JSX.Element | null {
  if (!opinion) return null;
  const { stt, grade, errors } = opinion;
  return (
    <div
      data-review-opinion=""
      className={`mt-2 flex flex-col gap-2 rounded-xl border p-2 text-xs ${
        isSuspect(score) ? "border-rose-400/40 bg-rose-500/5" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      {stt ? (
        <div className="text-amber-100/70">
          <span className="text-amber-100/50">{fill(s.reviewOpinionHeardAlt, { model: stt.model })}: </span>
          <span className="text-amber-50">{stt.alt_transcript || "–"}</span>
          <span className="ml-2 text-amber-100/50">· {fill(s.reviewOpinionAgreement, { percent: Math.round(stt.agreement * 100) })}</span>
        </div>
      ) : errors.stt ? (
        <div className="text-rose-200/80">{s.reviewOpinionSttFailed}</div>
      ) : null}
      {grade ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Score label={s.reviewOpinionMeaning} value={grade.meaning} />
            <Score label={s.reviewOpinionTone} value={grade.tone} />
            <span className="text-amber-100/40">{grade.model}</span>
          </div>
          {grade.issues.length > 0 ? (
            <ul className="flex flex-col gap-1">
              <li className="text-amber-100/50">{s.reviewOpinionIssues}</li>
              {grade.issues.map((issue, i) => (
                <li key={i} className="text-amber-100/80">
                  <span className="rounded border border-white/10 px-1 text-amber-200/80">{s[ISSUE_KEY[issue.kind]]}</span>{" "}
                  {issue.span ? <span className="text-amber-50">“{issue.span}”</span> : null} {issue.why}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-amber-100/50">{s.reviewOpinionNoIssues}</div>
          )}
          {grade.suggested_translation ? (
            <div>
              <span className="text-amber-100/50">{s.reviewOpinionSuggested}: </span>
              <span className="text-amber-50">{grade.suggested_translation}</span>
            </div>
          ) : null}
        </>
      ) : errors.grade ? (
        <div className="text-rose-200/80">{s.reviewOpinionGradeFailed}</div>
      ) : null}
      <div className="text-amber-100/30">{s.reviewOpinionOnlyHighlights}</div>
    </div>
  );
}
