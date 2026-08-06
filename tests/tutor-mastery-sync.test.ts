import { describe, expect, it } from "vitest";
import { mergeMasteryRecords } from "@/lib/tutor/masterySync";
import type { MasteryRecord } from "@/lib/tutor/mastery";

function record(overrides: Partial<MasteryRecord> = {}): MasteryRecord {
  return {
    courseId: "tom-spanish-1",
    lessonId: "tom-spanish-1-day-01",
    drillId: "recall-necesito",
    state: "recognized",
    attempts: 1,
    misses: 0,
    lastPracticedAt: "2026-08-06T18:00:00.000Z",
    nextReviewAt: "2026-08-07T18:00:00.000Z",
    ...overrides
  };
}

describe("cross-device Tutor mastery merge", () => {
  it("uses the newest attempt while never moving counters backward", () => {
    const local = record({ attempts: 5, misses: 1, lastScore: 82 });
    const remote = record({
      state: "recalled-independently",
      attempts: 3,
      misses: 0,
      lastScore: 91,
      lastPracticedAt: "2026-08-06T19:00:00.000Z",
      nextReviewAt: "2026-08-09T19:00:00.000Z"
    });
    const [merged] = mergeMasteryRecords([local], [remote]);
    expect(merged.state).toBe("recalled-independently");
    expect(merged.lastScore).toBe(91);
    expect(merged.attempts).toBe(5);
    expect(merged.misses).toBe(1);
    expect(merged.nextReviewAt).toBe("2026-08-09T19:00:00.000Z");
  });

  it("preserves repeatedly-missed history unless the newest result is spoken acceptably", () => {
    const local = record({ attempts: 4, misses: 3, state: "repeatedly-missed" });
    const remote = record({
      attempts: 2,
      misses: 0,
      state: "recalled-independently",
      lastPracticedAt: "2026-08-06T19:00:00.000Z"
    });
    expect(mergeMasteryRecords([local], [remote])[0].state).toBe("repeatedly-missed");

    const spoken = { ...remote, state: "spoken-acceptably" as const, lastScore: 88 };
    expect(mergeMasteryRecords([local], [spoken])[0].state).toBe("spoken-acceptably");
  });

  it("keeps mirrored courses isolated even when lesson and drill ids resemble each other", () => {
    const tom = record();
    const liz = record({
      courseId: "liz-english-1",
      lessonId: "liz-english-1-day-01",
      state: "spoken-acceptably",
      lastPracticedAt: "2026-08-06T20:00:00.000Z"
    });
    const merged = mergeMasteryRecords([tom], [liz]);
    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.courseId).sort()).toEqual(["liz-english-1", "tom-spanish-1"]);
  });

  it("deduplicates the same course, lesson, and drill key", () => {
    const older = record();
    const newer = record({ state: "spoken-acceptably", lastPracticedAt: "2026-08-06T21:00:00.000Z" });
    const merged = mergeMasteryRecords([older], [newer]);
    expect(merged).toHaveLength(1);
    expect(merged[0].state).toBe("spoken-acceptably");
  });
});
