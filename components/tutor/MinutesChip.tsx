"use client";

// The minutes-remaining chip, in the tutor header.
//
// Deliberately quiet. This is a screen where somebody is trying to speak a
// language they are bad at, and a bright red countdown in the corner is a
// worse teacher than silence — so it is the same muted pill as the rest of the
// chrome until the number gets small, and only then does it warm up. It never
// counts down live during a session: that is the warning's job, once, two
// minutes out (lib/tutor/sessionClock.ts).
//
// Bilingual on the app's convention, "English · Español" on one line
// (lib/tutor/meterCopy.ts).

import { chipLabel } from "@/lib/tutor/meterCopy";
import type { TutorBalanceView } from "@/lib/tutor/balanceClient";

/** Under five minutes the chip stops being furniture and starts being a fact. */
const LOW_SECONDS = 5 * 60;

export function MinutesChip({
  balance,
  onClick
}: {
  /** null = not known yet. Renders nothing rather than a plausible zero. */
  balance: TutorBalanceView | null;
  onClick?: () => void;
}): JSX.Element | null {
  if (!balance) return null;

  const low = !balance.unlimited && balance.remainingSeconds < LOW_SECONDS;
  const out = !balance.unlimited && balance.remainingSeconds <= 0;
  const tone = out
    ? "border-rose-400/40 bg-rose-500/10 text-rose-100"
    : low
      ? "border-amber-300/40 bg-amber-400/10 text-amber-100"
      : "border-white/10 bg-white/5 text-amber-100/70";

  const label = chipLabel(balance.remainingSeconds, balance.unlimited);
  const title =
    balance.packSeconds > 0 && !balance.unlimited
      ? `${Math.floor(balance.packSeconds / 60)} min of that is pack minutes, which roll over`
      : undefined;

  const className = `rounded-full border px-3 py-1.5 text-xs whitespace-nowrap ${tone}`;

  if (!onClick) {
    return (
      <span className={className} title={title}>
        {label}
      </span>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className} title={title}>
      {label}
    </button>
  );
}
