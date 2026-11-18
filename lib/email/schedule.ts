// When is it "8 o'clock for this person", and has today's email gone?
//
// Pure functions over (now, a row). The hourly cron calls them; nothing here
// reads a clock or a database, which is what lets the tests walk a DST change
// one hour at a time.
//
// THE RULE. A row is due when, in ITS OWN time zone,
//   - the local hour is the chosen hour, or up to CATCH_UP_HOURS after it, and
//   - nothing has been sent on this local day.
// The window is what makes a skipped cron harmless (the 9:00 run sends what
// the 8:00 run missed) without turning "8 in the morning" into "whenever" —
// somebody who opts in at 3 pm hears nothing until tomorrow. The local-day
// stamp is what makes a doubled cron harmless.
//
// DST falls out of the same two lines. Spring forward: 02:00 does not exist,
// so an hour-2 row is caught by the 03:00 run through the window. Fall back:
// 01:00 happens twice, and the second one finds today already stamped.

import { CATCH_UP_HOURS, PAUSE_AFTER_DAYS } from "./config";

export interface LocalMoment {
  /** YYYY-MM-DD in the row's time zone. */
  day: string;
  /** 0–23 in the row's time zone. */
  hour: number;
}

export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock day and hour of `now` in `zone`. An unknown zone reads as UTC. */
export function localMoment(now: Date, zone: string): LocalMoment {
  const timeZone = isValidTimeZone(zone) ? zone : "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

export interface DueInput {
  send_hour: number;
  last_sent_day: string | null;
}

export function isDue(local: LocalMoment, row: DueInput): boolean {
  if (row.last_sent_day && row.last_sent_day >= local.day) return false;
  return local.hour >= row.send_hour && local.hour <= row.send_hour + CATCH_UP_HOURS;
}

export interface PauseInput {
  last_visit_at: string | null;
  opted_in_at: string | null;
}

/**
 * Has it been PAUSE_AFTER_DAYS since this person last opened /study or
 * /tutor? Counted from opting in when they have never visited since. A row
 * with neither date is not paused — no evidence, no punishment.
 */
export function shouldPause(row: PauseInput, now: Date): boolean {
  const ref = Date.parse(row.last_visit_at ?? row.opted_in_at ?? "");
  if (!Number.isFinite(ref)) return false;
  return now.getTime() - ref >= PAUSE_AFTER_DAYS * 86_400_000;
}

/** Whole days since 1970 for a YYYY-MM-DD string. */
export function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/** `days` plus `today`, de-duplicated, keeping only the last seven local days. */
export function withVisit(days: readonly string[] | null | undefined, today: string): string[] {
  const floor = dayNumber(today) - 6;
  const kept = new Set((days ?? []).filter((d) => dayNumber(d) >= floor && d <= today));
  kept.add(today);
  return [...kept].sort();
}

/** How many of the last seven local days had a visit. A number, nothing else. */
export function daysThisWeek(days: readonly string[] | null | undefined, today: string): number {
  const floor = dayNumber(today) - 6;
  return new Set((days ?? []).filter((d) => dayNumber(d) >= floor && d <= today)).size;
}
