import { NextResponse } from "next/server";
import { loadLessons } from "@/lib/tutor/parseLessons";
import { tutorEnabled } from "@/lib/release";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  // RC1: tutor is off (lib/release.ts). Free to serve, but the course content
  // is the premium feature's substance — no reason to hand it out.
  if (!tutorEnabled()) {
    return NextResponse.json({ lessons: [], error: "not_found" }, { status: 404 });
  }

  try {
    const lessons = await loadLessons();
    return NextResponse.json({ lessons });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load lessons.";
    return NextResponse.json({ lessons: [], error: message }, { status: 500 });
  }
}
