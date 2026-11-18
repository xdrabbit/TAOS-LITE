// The daily study reminder: who may have it, and whether this deployment can
// send it at all (Tom, 2026-11-18: "we want them to invite us into their
// lives every day").
//
// Two separate questions, kept separate on purpose:
//
//   AUDIENCE  — TAOS_DAILY_EMAIL = off | founders | all. Default `founders`,
//               so Tom and Liz live with it before any customer sees the
//               toggle. Anything unrecognised is `founders`, never `all`: a
//               typo must not email customers.
//   READINESS — every env var a send needs. One missing and the feature is
//               INERT: no toggle is drawn, the cron says so in one log line,
//               and nothing errors. The footer address is in this list
//               because CAN-SPAM needs a physical address in every email and
//               nobody but Tom may pick one — so there is no default.
//
// Server-only. None of these are NEXT_PUBLIC: the browser asks
// GET /api/email/prefs and is told `available` or not.

import { isFounder } from "@/lib/release";

export type DailyEmailAudience = "off" | "founders" | "all";

export function dailyEmailAudience(raw: string | undefined = process.env.TAOS_DAILY_EMAIL): DailyEmailAudience {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "off" || value === "all") return value;
  return "founders";
}

/**
 * The shared-passcode account (components/SignIn.tsx). Many people sign in as
 * it and its address is nobody's inbox, so it is never offered the toggle and
 * never mailed. tests/daily-email.test.ts pins it against SignIn.tsx.
 */
export const SHARED_ACCOUNT_EMAIL = "taos@ritualstack.io";

export function audienceAllows(mode: DailyEmailAudience, email: string | null | undefined): boolean {
  if (mode === "off" || !email) return false;
  if (email.trim().toLowerCase() === SHARED_ACCOUNT_EMAIL) return false;
  return mode === "all" ? true : isFounder(email);
}

/** What a send needs, by NAME. Values are never logged or returned. */
export const REQUIRED_ENV = [
  "RESEND_API_KEY",
  "TAOS_EMAIL_FROM",
  "TAOS_EMAIL_FOOTER_ADDRESS",
  "TAOS_EMAIL_LINK_SECRET"
] as const;

type Env = Record<string, string | undefined>;

/** Names of the required vars that are unset or blank. Empty = ready. */
export function missingEmailEnv(env: Env = process.env): string[] {
  return REQUIRED_ENV.filter((name) => !(env[name] ?? "").trim());
}

export interface EmailSettings {
  apiKey: string;
  from: string;
  footerAddress: string;
  linkSecret: string;
}

/** The settings, or null when anything is missing. */
export function emailSettings(env: Env = process.env): EmailSettings | null {
  if (missingEmailEnv(env).length) return null;
  return {
    apiKey: (env.RESEND_API_KEY ?? "").trim(),
    from: (env.TAOS_EMAIL_FROM ?? "").trim(),
    footerAddress: (env.TAOS_EMAIL_FOOTER_ADDRESS ?? "").trim(),
    linkSecret: (env.TAOS_EMAIL_LINK_SECRET ?? "").trim()
  };
}

/** The URL marker that says "this visit came from the daily email". */
export const EMAIL_SOURCE = "daily-email";

/** Days without a visit to /study or /tutor before the emails pause themselves. */
export const PAUSE_AFTER_DAYS = 21;

/** How many hours after the chosen hour a missed send may still go out. */
export const CATCH_UP_HOURS = 3;

export const DEFAULT_SEND_HOUR = 8;
