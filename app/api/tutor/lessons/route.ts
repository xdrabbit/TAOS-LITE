import { NextResponse } from "next/server";
import { loadLessons } from "@/lib/tutor/parseLessons";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  try {
    const lessons = await loadLessons();
    return NextResponse.json({ lessons });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load lessons.";
    return NextResponse.json({ lessons: [], error: message }, { status: 500 });
  }
}
