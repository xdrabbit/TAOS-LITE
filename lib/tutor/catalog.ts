import { dayOneLessons } from "@/content/tutor-courses/day-01";
import type { CourseId, TutorLesson } from "./course";

const lessonsByCourse: Record<CourseId, TutorLesson[]> = {
  "tom-spanish-1": [dayOneLessons["tom-spanish-1"]],
  "liz-english-1": [dayOneLessons["liz-english-1"]]
};

export function listCourseLessons(courseId: CourseId): TutorLesson[] {
  return lessonsByCourse[courseId] ?? [];
}

export function getCourseLesson(courseId: CourseId, day: number): TutorLesson | undefined {
  return listCourseLessons(courseId).find((lesson) => lesson.day === day);
}
