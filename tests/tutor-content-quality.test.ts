import { describe, expect, it } from "vitest";
import { getCourse } from "@/lib/tutor/courses";
import { listCourseLessons } from "@/lib/tutor/lessonCatalog";

const courseIds = ["tom-spanish-1", "liz-english-1"] as const;

function normalized(text: string): string {
  return text.trim().toLocaleLowerCase();
}

describe("Sprint 1 Tutor content quality", () => {
  it("keeps every mirrored lesson deep enough for daily use", () => {
    for (const courseId of courseIds) {
      const lessons = listCourseLessons(courseId);
      expect(lessons).toHaveLength(10);

      for (const lesson of lessons) {
        expect(lesson.anchorSentences.length, `${lesson.id} anchors`).toBeGreaterThanOrEqual(5);
        expect(lesson.drills.length, `${lesson.id} drills`).toBeGreaterThanOrEqual(5);
        expect(lesson.miniDialogue.length, `${lesson.id} dialogue`).toBeGreaterThanOrEqual(4);
        expect(lesson.takeaway?.trim().length, `${lesson.id} takeaway`).toBeGreaterThanOrEqual(24);
        expect(lesson.usageNote?.trim().length, `${lesson.id} usage note`).toBeGreaterThanOrEqual(24);
      }
    }
  });

  it("provides meaningful substitution breadth in every lesson", () => {
    for (const courseId of courseIds) {
      for (const lesson of listCourseLessons(courseId)) {
        const substitutionDrills = lesson.drills.filter((drill) => drill.kind === "substitution");
        expect(substitutionDrills.length, `${lesson.id} substitution drills`).toBeGreaterThanOrEqual(1);
        const valueCount = substitutionDrills.flatMap((drill) => drill.substitutions ?? []).flatMap((slot) => slot.values).length;
        expect(valueCount, `${lesson.id} substitution values`).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("keeps anchors unique and bilingual", () => {
    for (const courseId of courseIds) {
      for (const lesson of listCourseLessons(courseId)) {
        const keys = lesson.anchorSentences.map((anchor) => `${normalized(anchor.source)}::${normalized(anchor.target)}`);
        expect(new Set(keys).size, `${lesson.id} duplicate anchors`).toBe(keys.length);
        for (const anchor of lesson.anchorSentences) {
          expect(anchor.source.trim()).not.toBe("");
          expect(anchor.target.trim()).not.toBe("");
          expect(normalized(anchor.source)).not.toBe(normalized(anchor.target));
        }
      }
    }
  });

  it("keeps explanation language aligned with each learner", () => {
    for (const courseId of courseIds) {
      const course = getCourse(courseId);
      for (const lesson of listCourseLessons(courseId)) {
        if (course.explanationLanguage === "es") {
          expect(lesson.takeaway).toMatch(/[áéíóúñ¿¡]|\b(el|la|los|las|un|una|usa|inglés|verbo)\b/i);
          expect(lesson.usageNote).toMatch(/[áéíóúñ¿¡]|\b(el|la|los|las|un|una|usa|inglés|verbo)\b/i);
        } else {
          expect(lesson.takeaway).toMatch(/\b(the|a|an|use|put|review|conversation|spanish)\b/i);
          expect(lesson.usageNote).toMatch(/\b(the|a|an|use|spanish|learn|when|time)\b/i);
        }
      }
    }
  });

  it("preserves stronger milestone experiences on Days 7 and 10", () => {
    for (const courseId of courseIds) {
      const lessons = listCourseLessons(courseId);
      const daySeven = lessons.find((lesson) => lesson.day === 7);
      const dayTen = lessons.find((lesson) => lesson.day === 10);
      expect(daySeven?.completion.minimumIndependentRecalls).toBeGreaterThanOrEqual(4);
      expect(daySeven?.completion.minimumSpokenAttempts).toBeGreaterThanOrEqual(5);
      expect(dayTen?.completion.minimumIndependentRecalls).toBeGreaterThanOrEqual(4);
      expect(dayTen?.completion.minimumSpokenAttempts).toBeGreaterThanOrEqual(5);
      expect(dayTen?.miniDialogue.length).toBeGreaterThanOrEqual(6);
    }
  });
});
