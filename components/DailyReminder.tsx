"use client";

// "Remind me every day" — the opt-in for the daily study email, on /study and
// /tutor (Tom, 2026-11-18).
//
// OFF by default, and nobody is mailed who did not turn this on. The server
// decides whether this is drawn at all (GET-equivalent in the visit call
// below): with TAOS_DAILY_EMAIL=off, for anyone outside the audience, while
// an env var is missing, or before the table exists, the answer is
// `available: false` and this renders NOTHING — no disabled switch, no
// "coming soon".
//
// One request on mount does three jobs: tells the server this person visited
// (which is what keeps the emails from auto-pausing, and un-pauses them),
// carries the "came from the email" marker when there is one, and brings back
// the current setting.
//
// The time zone is the browser's own, read at the moment of opting in. It is
// never guessed and never asked for.

import { useEffect, useState } from "react";
import { postPrefs, takeEmailSource } from "@/lib/email/client";
import { emailCopy } from "@/lib/email/copy";
import type { PrefsView } from "@/lib/email/prefsApi";

function hourLabel(hour: number, lang: string): string {
  try {
    return new Date(2026, 0, 1, hour).toLocaleTimeString(lang, { hour: "numeric", minute: "2-digit" });
  } catch {
    return `${hour}:00`;
  }
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export function DailyReminder({
  dest,
  lang
}: {
  /** Which screen this is on — counted with the visit. */
  dest: "study" | "tutor";
  /** The person's OWN language (the pair's `mine`): the email is written in it. */
  lang: string;
}): JSX.Element | null {
  const [prefs, setPrefs] = useState<PrefsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void postPrefs({ action: "visit", dest, src: takeEmailSource() ?? undefined }).then((payload) => {
      if (active) setPrefs(payload.available ? payload.prefs : null);
    });
    return () => {
      active = false;
    };
  }, [dest]);

  if (!prefs) return null;
  const c = emailCopy(lang);

  async function save(change: { optedIn?: boolean; hour?: number }): Promise<void> {
    setBusy(true);
    setFailed(false);
    const payload = await postPrefs({ action: "set", ...change, timeZone: browserTimeZone(), lang });
    setBusy(false);
    if (payload.available) setPrefs(payload.prefs);
    else setFailed(true);
  }

  const note = failed ? c.toggleFailed : prefs.bounced ? c.toggleBounced : prefs.optedIn && prefs.paused ? c.togglePaused : c.toggleHint;

  return (
    <section
      data-daily-reminder
      className="flex flex-col gap-1 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2"
    >
      <div className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex min-h-[44px] flex-1 cursor-pointer items-center gap-3 text-sm text-amber-100">
          <input
            type="checkbox"
            className="h-5 w-5 accent-amber-400"
            checked={prefs.optedIn}
            disabled={busy || prefs.bounced}
            onChange={(e) => void save({ optedIn: e.target.checked, hour: prefs.hour })}
          />
          {c.toggle}
        </label>
        {prefs.optedIn ? (
          <label className="flex items-center gap-2 text-sm text-amber-100/70">
            {c.toggleAt}
            <select
              className="min-h-[44px] rounded-xl border border-white/15 bg-white/[0.04] px-2 text-sm text-amber-100"
              value={prefs.hour}
              disabled={busy}
              aria-label={`${c.toggle} — ${c.toggleAt}`}
              onChange={(e) => void save({ hour: Number(e.target.value) })}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hourLabel(h, lang)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <p role={failed ? "alert" : undefined} className="pb-1 text-xs leading-snug text-amber-100/55">
        {note}
      </p>
    </section>
  );
}
