// Nobody gets stuck on a phrase.
//
// This is Liz's fence. She was the first person outside this repo to walk the
// curriculum, and Crawl held her on the same phrase asking for a pronunciation
// she was not going to produce that day — "close enough, move on". The rule
// that came out of it has two halves and the tests below pin both:
//
//   pass the bar   → advance, earned
//   three tries    → advance anyway, warmly, and remember the phrase
//
// The half that will be tempting to "fix" later is the second one. Raising the
// cap, or making the review mark block the advance, puts the trap straight
// back. Change either only with Tom or Liz saying so.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CRAWL_MAX_ATTEMPTS,
  CRAWL_PASS_SCORE,
  CRAWL_PASS_SCORES,
  crawlFraming,
  crawlOutcome,
  crawlPassScore,
  crawlScore
} from "@/lib/tutor/crawl";
import {
  MAX_REVIEW_MARKS,
  isMarkedForReview,
  markForReview,
  parseStoredProgress,
  progressKey,
  recordScore
} from "@/lib/tutor/progress";

const KEY = progressKey("needs-wants", "es", "en");

describe("the pass bar", () => {
  it("is 60 — close enough, which is the whole point", () => {
    expect(CRAWL_PASS_SCORE).toBe(60);
    expect(crawlPassScore("beginner")).toBe(60);
  });

  it("rises with a level the learner chose for themselves", () => {
    expect(CRAWL_PASS_SCORES.intermediate).toBe(70);
    expect(CRAWL_PASS_SCORES.advanced).toBe(80);
    expect(crawlPassScore("advanced")).toBe(80);
  });

  it("advances the moment the bar is met, not exceeded", () => {
    const out = crawlOutcome({ score: 60, attempts: 1 });
    expect(out.verdict).toBe("passed");
    expect(out.advance).toBe(true);
    expect(out.markForReview).toBe(false);
  });

  it("rounds the way the screen does, so 59.6 passes", () => {
    // The learner sees 60. Failing them on a decimal they cannot see is the
    // arbitrary feeling this change exists to remove.
    expect(crawlOutcome({ score: 59.6, attempts: 1 }).verdict).toBe("passed");
    expect(crawlOutcome({ score: 59.4, attempts: 1 }).verdict).toBe("retry");
  });

  it("measures against the level's bar, not always 60", () => {
    expect(crawlOutcome({ score: 65, attempts: 1, level: "beginner" }).verdict).toBe("passed");
    expect(crawlOutcome({ score: 65, attempts: 1, level: "advanced" }).verdict).toBe("retry");
    expect(crawlOutcome({ score: 65, attempts: 1, level: "advanced" }).threshold).toBe(80);
  });
});

describe("below the bar", () => {
  it("asks for another go while attempts remain", () => {
    const first = crawlOutcome({ score: 41, attempts: 1 });
    expect(first.verdict).toBe("retry");
    expect(first.advance).toBe(false);
    expect(first.attemptsLeft).toBe(2);

    const second = crawlOutcome({ score: 44, attempts: 2 });
    expect(second.verdict).toBe("retry");
    expect(second.advance).toBe(false);
    expect(second.attemptsLeft).toBe(1);
  });

  it("moves on after the third attempt, and marks the phrase for review", () => {
    // The one that matters. A third miss is not a fourth prompt to try again.
    const third = crawlOutcome({ score: 44, attempts: 3 });
    expect(CRAWL_MAX_ATTEMPTS).toBe(3);
    expect(third.verdict).toBe("moving-on");
    expect(third.advance).toBe(true);
    expect(third.markForReview).toBe(true);
    expect(third.attemptsLeft).toBe(0);
  });

  it("cannot trap a learner at ANY level or ANY score", () => {
    for (const level of ["beginner", "intermediate", "advanced"] as const) {
      for (const score of [0, 1, 17, 42, 59, 79]) {
        const out = crawlOutcome({ score, attempts: CRAWL_MAX_ATTEMPTS, level });
        expect(out.advance, `${level} @ ${score}`).toBe(true);
      }
    }
  });

  it("never marks a phrase the learner actually passed", () => {
    const out = crawlOutcome({ score: 91, attempts: 3 });
    expect(out.verdict).toBe("passed");
    expect(out.markForReview).toBe(false);
  });
});

describe("which Azure number is the gate", () => {
  // PronScore, surfaced by app/api/tutor/assess/route.ts as `pron`. It is the
  // number already shown on screen and already stored as bestScore, so gating
  // on anything else would advance on a number the learner never saw.
  it("is PronScore when Azure gives one", () => {
    expect(crawlScore({ pron: 72, accuracy: 88 })).toBe(72);
  });

  it("falls back to accuracy on a partial assessment", () => {
    expect(crawlScore({ pron: null, accuracy: 88 })).toBe(88);
  });

  it("says nothing rather than guessing zero", () => {
    // Zero would read as a catastrophic attempt and burn one of three tries
    // on an assessment that never happened.
    expect(crawlScore({ pron: null, accuracy: null })).toBeNull();
    expect(crawlScore({})).toBeNull();
    expect(crawlScore(null)).toBeNull();
  });
});

describe("what the screen says", () => {
  it("is bilingual, the way the rest of the tutor chrome is", () => {
    for (const verdict of ["passed", "retry", "moving-on"] as const) {
      expect(crawlFraming(verdict), verdict).toContain("·");
    }
  });

  it("frames the cap as circling back, never as failing", () => {
    expect(crawlFraming("moving-on")).toBe(
      "Close enough — we'll circle back · Suficiente por ahora — volveremos"
    );
  });

  it("never tells the learner they failed", () => {
    // Tone is a decided behavior here, not styling: this text is the whole
    // difference between "move on" and "you didn't make it".
    for (const verdict of ["passed", "retry", "moving-on"] as const) {
      expect(crawlFraming(verdict).toLowerCase(), verdict).not.toMatch(
        /fail|wrong|incorrect|no pasaste|mal\b/
      );
    }
  });
});

describe("the review mark", () => {
  it("remembers a phrase Crawl gave up on", () => {
    const p = markForReview({}, KEY, "¿Dónde está el baño?");
    expect(isMarkedForReview(p, KEY, "¿Dónde está el baño?")).toBe(true);
    expect(isMarkedForReview(p, KEY, "otra frase")).toBe(false);
  });

  it("is a set, not a tally — the same miss twice is one entry", () => {
    let p = markForReview({}, KEY, "quiero agua");
    p = markForReview(p, KEY, "quiero agua");
    expect(p[KEY].review).toEqual(["quiero agua"]);
  });

  it("rides alongside the best score instead of replacing the entry", () => {
    let p = recordScore({}, KEY, 71);
    p = markForReview(p, KEY, "quiero agua");
    expect(p[KEY].bestScore).toBe(71);
    expect(p[KEY].review).toEqual(["quiero agua"]);
  });

  it("is bounded, so a looping phone cannot grow the record forever", () => {
    let p: ReturnType<typeof markForReview> = {};
    for (let i = 0; i < MAX_REVIEW_MARKS + 5; i += 1) p = markForReview(p, KEY, `phrase ${i}`);
    expect(p[KEY].review).toHaveLength(MAX_REVIEW_MARKS);
    expect(p[KEY].review?.[MAX_REVIEW_MARKS - 1]).toBe(`phrase ${MAX_REVIEW_MARKS + 4}`);
  });

  it("survives whatever is actually in localStorage", () => {
    expect(parseStoredProgress('{"a":{"review":["x","x","y"]}}')).toEqual({
      a: { review: ["x", "y"] }
    });
    expect(parseStoredProgress('{"a":{"review":"nope"}}')).toEqual({ a: {} });
    expect(parseStoredProgress('{"a":{"review":[1,null,"y"]}}')).toEqual({ a: { review: ["y"] } });
  });
});

// The rule lives in lib/tutor/crawl.ts, but it only helps Liz if the screen
// actually asks it. Source-reading, the way tests/tutor-flag.test.ts checks
// the meter hooks — a phone is the only other way to see this wiring.
describe("the Crawl screen is wired to the rule", () => {
  const shell = readFileSync(new URL("../components/tutor/ModulesShell.tsx", import.meta.url), "utf8");

  it("asks crawlOutcome what to do with a score", () => {
    expect(shell).toContain("crawlOutcome(");
    expect(shell).toContain("crawlFraming(");
  });

  it("advances on the verdict rather than waiting for a tap", () => {
    expect(shell).toContain("verdict.advance");
  });

  it("writes the review mark when the cap fires", () => {
    expect(shell).toContain("verdict.markForReview");
    expect(shell).toContain("markForReview");
  });

  it("shows the score and the bar it is being measured against", () => {
    expect(shell).toContain("to pass");
    expect(shell).toContain("passScore");
  });

  it("does not auto-start Walk, which would spend realtime minutes on a timer", () => {
    expect(shell).toContain("!lastPhrase");
  });
});
