"use client";

// The card a learner sees when the meter says no.
//
// Reuses the Paywall's shape — same rounded panel, same amber primary button,
// same "Manage billing" footing — rather than inventing a second visual
// language for the same conversation, and it hands off TO components/Paywall
// for anything that actually charges. What it adds is the part the plan
// chooser cannot know: where this person stands right now, and which of the
// two doors is theirs.
//
// A free learner is shown plans; a subscriber is shown packs. Selling a
// subscriber the subscription they already have is the moment people cancel.
//
// Copy lives in lib/tutor/meterCopy.ts and is bilingual: the sentences get the
// /about treatment (an English block and a Spanish block, stacked) and the
// short labels get the chrome convention ("See plans · Ver planes"). Half this
// household reads the Spanish first.

import {
  ADD_MINUTES,
  EXHAUSTED_TITLE,
  ROLLOVER_NOTE,
  SEE_PLANS,
  exhaustedBody,
  joinBilingual,
  minutesLabel
} from "@/lib/tutor/meterCopy";
import type { TutorBalanceView } from "@/lib/tutor/balanceClient";

export function OutOfMinutes({
  balance,
  onSeePlans,
  onBuyPack,
  busy
}: {
  balance: TutorBalanceView;
  onSeePlans: () => void;
  /** Absent for free accounts: packs are a subscriber add-on (/api/stripe/pack). */
  onBuyPack?: (pack: "100" | "200") => void;
  busy?: string | null;
}): JSX.Element {
  const isPaid = balance.tier === "basic" || balance.tier === "premium" || balance.tier === "comp";
  const body = exhaustedBody(balance.tier, balance.packSeconds);
  const left = minutesLabel(balance.remainingSeconds);

  return (
    <div className="rounded-3xl border border-amber-300/25 bg-[rgba(20,16,14,0.86)] p-5">
      <h2 className="text-lg font-semibold text-amber-200">{joinBilingual(EXHAUSTED_TITLE)}</h2>

      {/* Where they stand, stated before anything is offered. */}
      <p className="mt-2 text-sm text-amber-100/70">
        {joinBilingual(left)}
        {balance.packSeconds > 0 ? (
          <span className="text-amber-100/45">
            {" "}
            · {Math.floor(balance.packSeconds / 60)} min in your pack
          </span>
        ) : null}
      </p>

      <p className="mt-3 text-sm text-amber-50/80">{body.en}</p>
      <p className="mt-1.5 text-sm text-amber-50/55">{body.es}</p>

      {isPaid && onBuyPack ? (
        <>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => onBuyPack("100")}
              disabled={Boolean(busy)}
              className="flex-1 rounded-2xl bg-amber-400 px-3 py-3 text-sm font-semibold text-stone-950 transition hover:bg-amber-300 disabled:opacity-60"
            >
              {busy === "pack-100" ? "Opening…" : "+100 min · $9.99"}
            </button>
            <button
              type="button"
              onClick={() => onBuyPack("200")}
              disabled={Boolean(busy)}
              className="flex-1 rounded-2xl border border-amber-300/30 bg-white/5 px-3 py-3 text-sm text-amber-100 transition hover:bg-white/10 disabled:opacity-60"
            >
              {busy === "pack-200" ? "Opening…" : "+200 min · $17.99"}
            </button>
          </div>
          <p className="mt-2 text-xs text-amber-100/40">{ROLLOVER_NOTE.en}</p>
          <p className="text-xs text-amber-100/30">{ROLLOVER_NOTE.es}</p>
          <button
            type="button"
            onClick={onSeePlans}
            className="mt-3 w-full text-center text-xs text-amber-100/50 underline-offset-2 hover:underline"
          >
            {joinBilingual(SEE_PLANS)}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={onSeePlans}
          className="mt-4 w-full rounded-2xl bg-amber-400 px-5 py-3 text-base font-semibold text-stone-950 transition hover:bg-amber-300"
        >
          {joinBilingual(isPaid ? ADD_MINUTES : SEE_PLANS)}
        </button>
      )}
    </div>
  );
}
