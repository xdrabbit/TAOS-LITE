// @vitest-environment jsdom
//
// The second opinion as the page draws it: the differing words marked in the
// transcript, the grade and the issues under the translation, in the
// owner's language — and no flag button anywhere in the panel.
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { copyFor } from "@/lib/chrome/copy";
import { wordDiff, type ReviewOpinion } from "@/lib/review/opinion";
import { OpinionPanel, TranscriptWithDiff } from "@/components/review/SecondOpinion";

const ORIGINAL = "Pero es seguro, ya pagué la cuenta de la casa";
const ALT = "Pero el seguro, ya pagué la cuenta de la cosa";

function opinionFor(): ReviewOpinion {
  const diff = wordDiff(ORIGINAL, ALT);
  return {
    stt: { model: "whisper-1", alt_transcript: ALT, agreement: diff.agreement, diff: diff.spans },
    grade: {
      model: "gpt-5.5",
      meaning: 2,
      tone: 4,
      issues: [{ span: "insurance", kind: "wrong-word", why: "seguro means safe here" }],
      suggested_translation: "But it's safe, I already paid the house bill"
    },
    errors: {}
  };
}

afterEach(cleanup);

describe("the transcript with the diff", () => {
  it("marks exactly the words the second transcriber heard differently, and keeps the rest verbatim", () => {
    render(createElement(TranscriptWithDiff, { text: ORIGINAL, opinion: opinionFor() }));
    const marks = Array.from(document.querySelectorAll("[data-review-diff]"));
    expect(marks.map((m) => m.textContent)).toEqual(["es", "casa"]);
    expect(marks[0].getAttribute("title")).toBe("→ el");
    expect(marks[1].getAttribute("title")).toBe("→ cosa");
    expect(document.body.textContent).toBe(ORIGINAL);
  });

  it("is plain text when there is no opinion", () => {
    render(createElement(TranscriptWithDiff, { text: ORIGINAL, opinion: null }));
    expect(document.querySelectorAll("[data-review-diff]")).toHaveLength(0);
    expect(document.body.textContent).toBe(ORIGINAL);
  });
});

describe("the panel under the translation", () => {
  for (const lang of ["en", "es"] as const) {
    it(`shows the grade, the issues and the suggestion in ${lang}, with no flag button`, () => {
      const s = copyFor(lang);
      render(createElement(OpinionPanel, { opinion: opinionFor(), score: 0.4, s }));
      const text = document.body.textContent ?? "";
      expect(text).toContain(`${s.reviewOpinionMeaning} 2/5`);
      expect(text).toContain(`${s.reviewOpinionTone} 4/5`);
      expect(text).toContain(s.reviewIssueWrongWord);
      expect(text).toContain("seguro means safe here");
      expect(text).toContain("But it's safe, I already paid the house bill");
      expect(text).toContain(ALT);
      expect(text).toContain("80%");
      expect(text).toContain(s.reviewOpinionOnlyHighlights);
      expect(document.querySelectorAll("button")).toHaveLength(0);
      expect(document.querySelector("[data-review-opinion]")?.className).toContain("rose");
    });
  }

  it("says which half failed, and draws nothing when there is no opinion", () => {
    const s = copyFor("en");
    render(createElement(OpinionPanel, { opinion: { stt: null, grade: null, errors: { stt: "http_500", grade: "timeout" } }, score: null, s }));
    expect(document.body.textContent).toContain(s.reviewOpinionSttFailed);
    expect(document.body.textContent).toContain(s.reviewOpinionGradeFailed);
    cleanup();
    render(createElement(OpinionPanel, { opinion: null, score: null, s }));
    expect(document.body.textContent).toBe("");
  });
});
