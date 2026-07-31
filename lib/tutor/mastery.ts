import type { CourseId, TutorLesson } from "./course";

export type MasteryState =
  | "introduced"
  | "recognized"
  | "recalled-with-help"
  | "recalled-independently"
  | "spoken-acceptably"
  | "due"
  | "repeatedly-missed";

export interface MasteryRecord {
  courseId: CourseId;
  lessonId: string;
  drillId: string;
  state: MasteryState;
  attempts: number;
  misses: number;
  lastScore?: number;
  lastPracticedAt: string;
  nextReviewAt?: string;
}

const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14] as const;

export function nextReviewDate(attempts: number, from = new Date()): string {
  const index = Math.min(Math.max(attempts - 1, 0), REVIEW_INTERVAL_DAYS.length - 1);
  const next = new Date(from);
  next.setUTCDate(next.getUTCDate() + REVIEW_INTERVAL_DAYS[index]);
  return next.toISOString();
}

export function updateMastery(
  previous: MasteryRecord | undefined,
  input: {
    courseId: CourseId;
    lessonId: string;
    drillId: string;
    score?: number;
    recalledWithoutHelp?: boolean;
    usedHint?: boolean;
    now?: Date;
  }
): MasteryRecord {
  const now = input.now ?? new Date();
  const attempts = (previous?.attempts ?? 0) + 1;
  const passed = typeof input.score === "number" ? input.score >= 70 : Boolean(input.recalledWithoutHelp);
  const misses = (previous?.misses ?? 0) + (passed ? 0 : 1);

  let state: MasteryState;
  if (typeof input.score === "number" && input.score >= 75) state = "spoken-acceptably";
  else if (input.recalledWithoutHelp && !input.usedHint) state = "recalled-independently";
  else if (input.recalledWithoutHelp || input.usedHint) state = "recalled-with-help";
  else if (misses >= 3) state = "repeatedly-missed";
  else state = "recognized";

  return {
    courseId: input.courseId,
    lessonId: input.lessonId,
    drillId: input.drillId,
    state,
    attempts,
    misses,
    lastScore: input.score,
    lastPracticedAt: now.toISOString(),
    nextReviewAt: nextReviewDate(attempts, now)
  };
}

export interface ReviewItem {
  lesson: TutorLesson;
  drillId: string;
  priority: number;
  reason: "due" | "weak" | "recent" | "retention";
}

export function buildReviewQueue(
  lessons: TutorLesson[],
  records: MasteryRecord[],
  now = new Date(),
  limit = 8
): ReviewItem[] {
  const byKey = new Map(records.map((record) => [`${record.lessonId}:${record.drillId}`, record]));
  const items: ReviewItem[] = [];

  for (const lesson of lessons) {
    for (const drill of lesson.drills) {
      if (!drill.reviewAfterDays?.length) continue;
      const record = byKey.get(`${lesson.id}:${drill.id}`);
      if (!record) {
        items.push({ lesson, drillId: drill.id, priority: 25 - lesson.day, reason: "recent" });
        continue;
      }
      const due = record.nextReviewAt ? new Date(record.nextReviewAt) <= now : false;
      const weak = record.state === "repeatedly-missed" || record.misses >= 2 || (record.lastScore ?? 100) < 65;
      const retention = record.state === "spoken-acceptably" && record.attempts >= 3;
      if (due || weak || retention) {
        items.push({
          lesson,
          drillId: drill.id,
          priority: weak ? 100 : due ? 80 : 20,
          reason: weak ? "weak" : due ? "due" : "retention"
        });
      }
    }
  }

  return items
    .sort((a, b) => b.priority - a.priority || a.lesson.day - b.lesson.day)
    .slice(0, limit);
}
