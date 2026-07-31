import { NextRequest, NextResponse } from "next/server";
import { listCourseLessons } from "@/lib/tutor/catalog";
import { getCourse, listCourses } from "@/lib/tutor/courses";
import type { CourseId } from "@/lib/tutor/course";

export const runtime = "nodejs";

const COURSE_IDS = new Set<CourseId>(["tom-spanish-1", "liz-english-1"]);

function isCourseId(value: string | null): value is CourseId {
  return value !== null && COURSE_IDS.has(value as CourseId);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const courseId = request.nextUrl.searchParams.get("courseId");

  if (!courseId) {
    return NextResponse.json({ courses: listCourses() });
  }

  if (!isCourseId(courseId)) {
    return NextResponse.json({ error: "Unknown Tutor course." }, { status: 400 });
  }

  return NextResponse.json({
    course: getCourse(courseId),
    lessons: listCourseLessons(courseId)
  });
}
