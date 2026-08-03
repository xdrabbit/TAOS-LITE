"use client";

import type { CourseId } from "./course";
import type { MasteryRecord } from "./mastery";

const STORAGE_PREFIX = "taos.tutor.mastery";

function storageKey(courseId: CourseId): string {
  return `${STORAGE_PREFIX}.${courseId}`;
}

function isRecord(value: unknown): value is MasteryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<MasteryRecord>;
  return Boolean(
    record.courseId &&
      record.lessonId &&
      record.drillId &&
      record.state &&
      typeof record.attempts === "number" &&
      typeof record.misses === "number" &&
      record.lastPracticedAt
  );
}

export function loadMastery(courseId: CourseId): MasteryRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(courseId)) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(isRecord).filter((record) => record.courseId === courseId)
      : [];
  } catch {
    return [];
  }
}

export function saveMastery(courseId: CourseId, records: MasteryRecord[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    storageKey(courseId),
    JSON.stringify(records.filter((record) => record.courseId === courseId))
  );
}

export function upsertMastery(records: MasteryRecord[], next: MasteryRecord): MasteryRecord[] {
  const key = `${next.lessonId}:${next.drillId}`;
  const withoutCurrent = records.filter((record) => `${record.lessonId}:${record.drillId}` !== key);
  return [...withoutCurrent, next];
}
