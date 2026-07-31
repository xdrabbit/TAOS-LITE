import { dayOneLessons } from "@/content/tutor-courses/day-01";
import { dayTwoLessons } from "@/content/tutor-courses/day-02";
import { dayThreeLessons } from "@/content/tutor-courses/day-03";
import { dayFourLessons } from "@/content/tutor-courses/day-04";
import { dayFiveLessons } from "@/content/tutor-courses/day-05";
import { daySixLessons } from "@/content/tutor-courses/day-06";
import { daySevenLessons } from "@/content/tutor-courses/day-07";
import { dayEightLessons } from "@/content/tutor-courses/day-08";
import { dayNineLessons } from "@/content/tutor-courses/day-09";
import { dayTenLessons } from "@/content/tutor-courses/day-10";
import type { CourseId, TutorLesson } from "./course";

const lessonsByCourse: Record<CourseId, TutorLesson[]> = {
  "tom-spanish-1": [
    dayOneLessons["tom-spanish-1"],
    dayTwoLessons["tom-spanish-1"],
    dayThreeLessons["tom-spanish-1"],
    dayFourLessons["tom-spanish-1"],
    dayFiveLessons["tom-spanish-1"],
    daySixLessons["tom-spanish-1"],
    daySevenLessons["tom-spanish-1"],
    dayEightLessons["tom-spanish-1"],
    dayNineLessons["tom-spanish-1"],
    dayTenLessons["tom-spanish-1"]
  ],
  "liz-english-1": [
    dayOneLessons["liz-english-1"],
    dayTwoLessons["liz-english-1"],
    dayThreeLessons["liz-english-1"],
    dayFourLessons["liz-english-1"],
    dayFiveLessons["liz-english-1"],
    daySixLessons["liz-english-1"],
    daySevenLessons["liz-english-1"],
    dayEightLessons["liz-english-1"],
    dayNineLessons["liz-english-1"],
    dayTenLessons["liz-english-1"]
  ]
};

export function listCourseLessons(courseId: CourseId): TutorLesson[] {
  return lessonsByCourse[courseId] ?? [];
}

export function getCourseLesson(courseId: CourseId, day: number): TutorLesson | undefined {
  return listCourseLessons(courseId).find((lesson) => lesson.day === day);
}
