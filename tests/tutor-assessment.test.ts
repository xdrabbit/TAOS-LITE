// The bug: Crawl rendered "—" for a score, every attempt, for a month.
//
// The route read `NBest[0].PronunciationAssessment.PronScore`, which is the
// Speech SDK's shape. The REST endpoint the app actually calls returns the
// scores FLAT on the NBest entry. Every layer degraded politely — `?? null`,
// a dash on screen, a coaching model happily told the score was 0 — so
// nothing ever failed loudly enough to notice.
//
// The fixture below is a REAL response, captured 2026-08-27 from the live
// Azure resource (westus2, es-MX) against real audio, trimmed to the fields
// the app reads. Its provenance is the whole point: a hand-written fixture in
// the shape the docs draw is what let this ship in the first place. The full
// run is written up in docs/tutor-crawl-gating-verification.md.
import { describe, expect, it } from "vitest";
import { parseAzureAssessment } from "@/lib/tutor/assessment";
import { crawlOutcome, crawlScore } from "@/lib/tutor/crawl";

/** Real. Azure westus2, es-MX, "Necesito ayuda, por favor." read badly. */
const REAL_FLAT_RESPONSE = {
  RecognitionStatus: "Success",
  DisplayText: "Necesito ayuda, por favor.",
  NBest: [
    {
      Confidence: 0.780532,
      Lexical: "Necesito ayuda por favor",
      Display: "Necesito ayuda, por favor.",
      AccuracyScore: 73,
      FluencyScore: 88,
      CompletenessScore: 75,
      PronScore: 76.4,
      Words: [
        { Word: "Necesito", AccuracyScore: 23, ErrorType: "Mispronunciation" },
        { Word: "ayuda", AccuracyScore: 97, ErrorType: "None" },
        { Word: "por", AccuracyScore: 97, ErrorType: "None" },
        { Word: "favor", AccuracyScore: 76, ErrorType: "None" }
      ]
    }
  ]
};

/** The shape the SDK and most of the documentation show. Also supported. */
const NESTED_RESPONSE = {
  DisplayText: "Necesito ayuda, por favor.",
  NBest: [
    {
      PronunciationAssessment: {
        AccuracyScore: 73,
        FluencyScore: 88,
        CompletenessScore: 75,
        ProsodyScore: 81,
        PronScore: 76.4
      },
      Words: [
        {
          Word: "Necesito",
          PronunciationAssessment: { AccuracyScore: 23, ErrorType: "Mispronunciation" }
        }
      ]
    }
  ]
};

describe("reading a real Azure response", () => {
  it("finds the scores where this endpoint actually puts them — flat", () => {
    const parsed = parseAzureAssessment(REAL_FLAT_RESPONSE);
    expect(parsed.pron).toBe(76.4);
    expect(parsed.accuracy).toBe(73);
    expect(parsed.fluency).toBe(88);
    expect(parsed.completeness).toBe(75);
    expect(parsed.transcript).toBe("Necesito ayuda, por favor.");
  });

  it("scores the words too — the chips were blank for the same reason", () => {
    const parsed = parseAzureAssessment(REAL_FLAT_RESPONSE);
    expect(parsed.words).toHaveLength(4);
    expect(parsed.words[0]).toEqual({
      word: "Necesito",
      accuracy: 23,
      errorType: "Mispronunciation"
    });
  });

  it("still reads the nested shape, because Azure has shipped both", () => {
    const parsed = parseAzureAssessment(NESTED_RESPONSE);
    expect(parsed.pron).toBe(76.4);
    expect(parsed.prosody).toBe(81);
    expect(parsed.words[0].accuracy).toBe(23);
  });

  it("says null rather than zero when there is genuinely no assessment", () => {
    // Zero would burn one of the learner's three attempts on a non-answer.
    const parsed = parseAzureAssessment({ RecognitionStatus: "NoMatch", NBest: [] });
    expect(parsed.pron).toBeNull();
    expect(parsed.words).toEqual([]);
    expect(parseAzureAssessment(null).pron).toBeNull();
    expect(parseAzureAssessment("nonsense").pron).toBeNull();
  });
});

// The two halves joined up: what Azure really said → what Crawl really does.
// This is the assertion the phase-1 verification was missing. "The request
// succeeded" was true the whole time; "a number reached the screen" was not.
describe("a real response reaches a real verdict", () => {
  it("advances a badly-read but recognizable attempt — Liz's close enough", () => {
    const score = crawlScore(parseAzureAssessment(REAL_FLAT_RESPONSE));
    expect(score).toBe(76.4);
    const out = crawlOutcome({ score: score as number, attempts: 1, level: "beginner" });
    expect(out.verdict).toBe("passed");
    expect(out.advance).toBe(true);
  });

  it("would have been trapped forever under the old reader", () => {
    // The regression this locks out: a null score is not a low score, and if
    // it ever comes back as one, no phrase can be passed by anyone.
    const blind = { NBest: [{ PronunciationAssessment: {} }] };
    expect(crawlScore(parseAzureAssessment(blind))).toBeNull();
  });
});
