// Reading Azure's answer, which is not the shape the docs draw.
//
// ── The bug this file exists for ───────────────────────────────────────────
// Crawl asked Azure for a pronunciation score and rendered "—" every single
// time. Not an error, not a banner: a dash where the number goes, on every
// attempt, in every language, since phase 1. The route was reading
//
//     NBest[0].PronunciationAssessment.PronScore
//
// which is the shape the Speech **SDK** hands you and the shape most of the
// documentation shows. The REST endpoint this app actually calls — the v1
// conversation recognition endpoint with `?format=detailed` — puts the four
// scores FLAT on the NBest entry instead, and does the same for every word:
//
//     NBest[0].PronScore                  ← real, westus2, 2026-08-27
//     NBest[0].Words[i].AccuracyScore
//
// Captured from the live resource rather than inferred (the run is written up
// in docs/tutor-crawl-gating-verification.md). One attempt, verbatim:
//
//     { "RecognitionStatus": "Success", "DisplayText": "Necesito ayuda, por favor.",
//       "NBest": [ { "AccuracyScore": 88, "FluencyScore": 94,
//                    "CompletenessScore": 100, "PronScore": 91.6,
//                    "Words": [ { "Word": "Necesito", "AccuracyScore": 91,
//                                 "ErrorType": "None" }, … ] } ] }
//
// So both shapes are read, nested first. Microsoft has shipped both and the
// app has no way to pin which one a given region answers with — a reader that
// only knows one of them is one region migration away from silently returning
// dashes again, which is exactly the failure that hid here for a month.
//
// ── Why it hid ────────────────────────────────────────────────────────────
// Every layer degraded politely. `pa.PronScore ?? null` on a missing object is
// null, not a throw. The screen renders null as "—". The coaching model was
// handed `Math.round(result.pron ?? 0)` and wrote fluent, plausible feedback
// about a score of zero. Nothing logged, nothing 500'd, and the phase-1
// verification pass recorded the leg as reaching Azure — which it did. The
// lesson worth keeping: "the request succeeded" is not "the number arrived",
// and only an assertion on the number itself can tell them apart.

/** One word, as scored. */
export interface AssessmentWord {
  word: string;
  accuracy: number | null;
  errorType: string | null;
}

/** What Crawl needs out of an assessment. All scores 0-100, or null. */
export interface AssessmentScores {
  transcript: string;
  accuracy: number | null;
  fluency: number | null;
  completeness: number | null;
  prosody: number | null;
  /** Microsoft's weighted overall. The number Crawl gates on. */
  pron: number | null;
  words: AssessmentWord[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A score that may be nested under `PronunciationAssessment` or sitting flat
 * on the object. Nested wins when both exist; they never disagree in practice,
 * and preferring the documented one keeps this honest if Azure ever ships both.
 */
function score(holder: Record<string, unknown>, field: string): number | null {
  return num(record(holder.PronunciationAssessment)[field]) ?? num(holder[field]);
}

export function parseAzureAssessment(data: unknown): AssessmentScores {
  const root = record(data);
  const nbest = record(Array.isArray(root.NBest) ? root.NBest[0] : null);

  const words: AssessmentWord[] = (Array.isArray(nbest.Words) ? nbest.Words : []).map((raw) => {
    const w = record(raw);
    const errorType = record(w.PronunciationAssessment).ErrorType ?? w.ErrorType;
    return {
      word: String(w.Word ?? ""),
      accuracy: score(w, "AccuracyScore"),
      errorType: typeof errorType === "string" ? errorType : null
    };
  });

  return {
    transcript: String(root.DisplayText ?? nbest.Display ?? ""),
    accuracy: score(nbest, "AccuracyScore"),
    fluency: score(nbest, "FluencyScore"),
    completeness: score(nbest, "CompletenessScore"),
    prosody: score(nbest, "ProsodyScore"),
    pron: score(nbest, "PronScore"),
    words
  };
}
