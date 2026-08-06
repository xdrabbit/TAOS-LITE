import type { CourseId } from "./course";
import type { MasteryRecord, MasteryState } from "./mastery";
import { supabase } from "@/lib/supabase";

interface TutorMasteryRow {
  course_id: CourseId;
  lesson_id: string;
  drill_id: string;
  state: MasteryState;
  attempts: number;
  misses: number;
  last_score: number | null;
  last_practiced_at: string;
  next_review_at: string | null;
}

function key(record: Pick<MasteryRecord, "courseId" | "lessonId" | "drillId">): string {
  return `${record.courseId}:${record.lessonId}:${record.drillId}`;
}

function validDate(value: string): number {
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

export function mergeMasteryRecords(local: MasteryRecord[], remote: MasteryRecord[]): MasteryRecord[] {
  const merged = new Map<string, MasteryRecord>();

  for (const record of [...local, ...remote]) {
    const recordKey = key(record);
    const previous = merged.get(recordKey);
    if (!previous) {
      merged.set(recordKey, record);
      continue;
    }

    const previousTime = validDate(previous.lastPracticedAt);
    const recordTime = validDate(record.lastPracticedAt);
    const newest = recordTime >= previousTime ? record : previous;
    const older = newest === record ? previous : record;
    const misses = Math.max(previous.misses, record.misses);
    const attempts = Math.max(previous.attempts, record.attempts, misses);

    merged.set(recordKey, {
      ...newest,
      attempts,
      misses,
      lastScore: newest.lastScore ?? older.lastScore,
      nextReviewAt: newest.nextReviewAt ?? older.nextReviewAt,
      state: misses >= 3 && newest.state !== "spoken-acceptably" ? "repeatedly-missed" : newest.state
    });
  }

  return [...merged.values()].sort(
    (a, b) => a.courseId.localeCompare(b.courseId) || a.lessonId.localeCompare(b.lessonId) || a.drillId.localeCompare(b.drillId)
  );
}

function fromRow(row: TutorMasteryRow): MasteryRecord {
  return {
    courseId: row.course_id,
    lessonId: row.lesson_id,
    drillId: row.drill_id,
    state: row.state,
    attempts: row.attempts,
    misses: row.misses,
    lastScore: row.last_score ?? undefined,
    lastPracticedAt: row.last_practiced_at,
    nextReviewAt: row.next_review_at ?? undefined
  };
}

function toRow(record: MasteryRecord): TutorMasteryRow {
  return {
    course_id: record.courseId,
    lesson_id: record.lessonId,
    drill_id: record.drillId,
    state: record.state,
    attempts: record.attempts,
    misses: record.misses,
    last_score: record.lastScore ?? null,
    last_practiced_at: record.lastPracticedAt,
    next_review_at: record.nextReviewAt ?? null
  };
}

export async function syncMastery(courseId: CourseId, local: MasteryRecord[]): Promise<MasteryRecord[]> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return local;

  const { data, error } = await supabase
    .from("tutor_mastery")
    .select("course_id, lesson_id, drill_id, state, attempts, misses, last_score, last_practiced_at, next_review_at")
    .eq("course_id", courseId);
  if (error) throw error;

  const remote = ((data ?? []) as TutorMasteryRow[]).map(fromRow);
  const merged = mergeMasteryRecords(
    local.filter((record) => record.courseId === courseId),
    remote.filter((record) => record.courseId === courseId)
  );

  if (merged.length) {
    const userId = sessionData.session.user.id;
    const rows = merged.map((record) => ({ user_id: userId, ...toRow(record) }));
    const { error: upsertError } = await supabase
      .from("tutor_mastery")
      .upsert(rows, { onConflict: "user_id,course_id,lesson_id,drill_id" });
    if (upsertError) throw upsertError;
  }

  return merged;
}
