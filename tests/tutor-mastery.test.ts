import { describe, expect, it } from "vitest";
import { dayOneLessons } from "@/content/tutor-courses/day-01";
import { buildReviewQueue, nextReviewDate, updateMastery } from "@/lib/tutor/mastery";

const NOW = new Date("2026-07-31T18:00:00.000Z");

describe("Tutor mastery", () => {
  it("uses deterministic 1, 3, 7, 14 day review intervals", () => {
    expect(nextReviewDate(1, NOW)).toBe("2026-08-01T18:00:00.000Z");
    expect(nextReviewDate(2, NOW)).toBe("2026-08-03T18:00:00.000Z");
    expect(nextReviewDate(3, NOW)).toBe("2026-08-07T18:00:00.000Z");
    expect(nextReviewDate(99, NOW)).toBe("2026-08-14T18:00:00.000Z");
  });

  it("promotes a good spoken attempt to spoken-acceptably", () => {
    const result = updateMastery(undefined, {
      courseId: "tom-spanish-1",
      lessonId: "tom-spanish-1-day-01",
      drillId: "repeat-quiero",
      score: 84,
      now: NOW
    });
    expect(result.state).toBe("spoken-acceptably");
    expect(result.nextReviewAt).toBe("2026-08-01T18:00:00.000Z");
  });

  it("prioritizes weak items in the review queue", () => {
    const lesson = dayOneLessons["tom-spanish-1"];
    const queue = buildReviewQueue(
      [lesson],
      [
        {
          courseId: "tom-spanish-1",
          lessonId: lesson.id,
          drillId: "repeat-quiero",
          state: "repeatedly-missed",
          attempts: 3,
          misses: 3,
          lastScore: 42,
          lastPracticedAt: NOW.toISOString(),
          nextReviewAt: "2026-08-10T18:00:00.000Z"
        }
      ],
      NOW
    );
    expect(queue[0]?.reason).toBe("weak");
  });
});
