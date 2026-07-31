import { describe, expect, it } from "vitest";
import { getCourse, listCourses } from "@/lib/tutor/courses";
import { getCourseLesson, listCourseLessons } from "@/lib/tutor/lessonCatalog";

const courseIds = ["tom-spanish-1", "liz-english-1"] as const;

describe("mirrored Tutor courses", () => {
  it("defines opposite target directions", () => {
    const tom = getCourse("tom-spanish-1");
    const liz = getCourse("liz-english-1");
    expect(tom.nativeLanguage).toBe("en");
    expect(tom.targetLanguage).toBe("es");
    expect(liz.nativeLanguage).toBe("es");
    expect(liz.targetLanguage).toBe("en");
  });

  it("exposes ten ordered lessons for each learner", () => {
    for (const courseId of courseIds) {
      const lessons = listCourseLessons(courseId);
      expect(lessons).toHaveLength(10);
      expect(lessons.map((lesson) => lesson.day)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
  });

  it("keeps course identity and target direction explicit", () => {
    for (const course of listCourses()) {
      for (const lesson of listCourseLessons(course.id)) {
        expect(lesson.courseId).toBe(course.id);
        expect(lesson.anchorSentences.length).toBeGreaterThanOrEqual(4);
        expect(lesson.drills.length).toBeGreaterThanOrEqual(5);
        expect(lesson.miniDialogue.length).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("provides deterministic review metadata throughout the first ten days", () => {
    for (const courseId of courseIds) {
      const reviewable = listCourseLessons(courseId).flatMap((lesson) => lesson.drills).filter((drill) => drill.reviewAfterDays);
      expect(reviewable.length).toBeGreaterThanOrEqual(20);
      for (const drill of reviewable) {
        expect(drill.reviewAfterDays).toEqual([1, 3, 7, 14]);
      }
    }
  });

  it("can retrieve milestone lessons by day", () => {
    expect(getCourseLesson("tom-spanish-1", 7)?.title).toContain("Review");
    expect(getCourseLesson("liz-english-1", 10)?.title).toContain("Complete conversation");
  });
});
