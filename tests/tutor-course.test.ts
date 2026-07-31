import { describe, expect, it } from "vitest";
import { dayOneLessons } from "@/content/tutor-courses/day-01";
import { getCourse, listCourses } from "@/lib/tutor/courses";
import { getCourseLesson } from "@/lib/tutor/catalog";

 describe("mirrored Tutor courses", () => {
  it("defines one course in each learning direction", () => {
    const courses = listCourses();
    expect(courses).toHaveLength(2);
    expect(getCourse("tom-spanish-1")).toMatchObject({
      learnerName: "Tom",
      nativeLanguage: "en",
      targetLanguage: "es",
      pronunciationLocale: "es-US"
    });
    expect(getCourse("liz-english-1")).toMatchObject({
      learnerName: "Liz",
      nativeLanguage: "es",
      targetLanguage: "en",
      pronunciationLocale: "en-US"
    });
  });

  it("provides a mirrored Day 1 without forcing identical wording", () => {
    const tom = dayOneLessons["tom-spanish-1"];
    const liz = dayOneLessons["liz-english-1"];

    expect(tom.day).toBe(1);
    expect(liz.day).toBe(1);
    expect(tom.anchorSentences[0]).toEqual({
      source: "I want coffee.",
      target: "Yo quiero café."
    });
    expect(liz.anchorSentences[0]).toEqual({
      source: "Yo quiero café.",
      target: "I want coffee."
    });
    expect(tom.drills.map((drill) => drill.kind)).toContain("substitution");
    expect(liz.drills.map((drill) => drill.kind)).toContain("recall");
  });

  it("finds lessons through the course catalog", () => {
    expect(getCourseLesson("tom-spanish-1", 1)?.id).toBe("tom-spanish-1-day-01");
    expect(getCourseLesson("liz-english-1", 90)).toBeUndefined();
  });
});
