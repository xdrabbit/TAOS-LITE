"use client";

import { useState } from "react";
import { tutorComingSoon } from "@/lib/release";
import { ENGLISH, copyFor, fill, type ChromeCopy, type ChromeKey } from "@/lib/chrome/copy";
import { startCheckout, startPackCheckout, supabase, type Tier } from "@/lib/supabase";

interface Plan {
  id: "basic" | "premium";
  /** A copy key, or null for "Premium", which is the same word in Spanish. */
  name: ChromeKey | null;
  price: string;
  features: { text: ChromeKey; tutor?: boolean }[];
  highlight?: boolean;
}

// "Premium" reads the same in both languages, so it is printed plain rather
// than given a key (see the paywall block in lib/chrome/copy.ts).
const PREMIUM = "Premium";

function planName(p: Plan, copy: ChromeCopy): string {
  return p.name ? copy[p.name] : PREMIUM;
}

// This is the screen with the Stripe button on it, so it is the one that has
// to be exactly true. Tutor is gated off (lib/release.ts): the minutes, the
// drills and the progress tracking all live behind /tutor, so each is flagged
// `tutor: true` and renders as pending rather than as something the charge
// buys today. Same flag as the nav — when tutor returns, so does the ✓.
//
// Every word on it is a key in lib/chrome/copy.ts, read in the phone owner's
// language (`mine`) — Tom's decision, 2026-10-04: Liz tapped "Mejorar el plan"
// on home and landed here in English. The prices are not words and stay as
// they are. Stripe's own pages (Checkout, the billing portal) are not ours to
// translate; they get the same language as a `locale` (lib/stripeLocale.ts).
const PLANS: Plan[] = [
  {
    id: "basic",
    name: "paywallBasic",
    price: "$5.99",
    features: [
      { text: "paywallUnlimited" },
      { text: "paywallTutorBasic", tutor: true },
      { text: "paywallDrills", tutor: true }
    ]
  },
  {
    id: "premium",
    name: null,
    price: "$19.99",
    features: [
      { text: "paywallUnlimited" },
      { text: "paywallTutorPremium", tutor: true },
      { text: "paywallDrills", tutor: true }
    ],
    highlight: true
  }
];

export function Paywall({
  email,
  mine,
  currentTier = "free",
  onClose,
  onSignOut
}: {
  email: string;
  /** The phone owner's language — what every word here is written in. */
  mine: string;
  currentTier?: Tier;
  onClose?: () => void;
  onSignOut: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPaid = currentTier === "basic" || currentTier === "premium";
  const comingSoon = tutorComingSoon();
  const copy = copyFor(mine);
  const plans = PLANS.map((p) => ({ ...p, label: planName(p, copy) }));

  // What went wrong, in the owner's language. The routes answer in English
  // (and Stripe in whatever Stripe says), which is fine for the log and no use
  // to Liz, so the raw message goes to the console and the screen says which
  // step failed. "Sign in again" is the one failure the reader can act on, so
  // it keeps its own sentence; lib/supabase.ts throws exactly ENGLISH's.
  function failed(e: unknown, fallback: "paywallCheckoutFailed" | "paywallBillingFailed") {
    const raw = e instanceof Error ? e.message : String(e);
    console.warn("[paywall]", raw);
    setError(raw === ENGLISH.paywallSignInAgain ? copy.paywallSignInAgain : copy[fallback]);
  }

  // Free users start a new checkout; existing subscribers switch plans in the
  // Stripe billing portal (avoids creating a second subscription).
  async function choose(plan: "basic" | "premium") {
    setBusy(plan);
    setError(null);
    try {
      if (isPaid) {
        await openPortal();
      } else {
        await startCheckout(plan, mine);
      }
    } catch (e) {
      failed(e, "paywallCheckoutFailed");
      setBusy(null);
    }
  }

  async function buyPack(pack: "100" | "200") {
    setBusy(`pack-${pack}`);
    setError(null);
    try {
      await startPackCheckout(pack, mine);
    } catch (e) {
      failed(e, "paywallCheckoutFailed");
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    setError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error(ENGLISH.paywallSignInAgain);
      const res = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ lang: mine })
      });
      const payload = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !payload.url) throw new Error(payload.error || ENGLISH.paywallBillingFailed);
      window.location.href = payload.url;
    } catch (e) {
      failed(e, "paywallBillingFailed");
      setBusy(null);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-8">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.3)]">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-amber-200">{copy.paywallTitle}</h1>
            <p className="mt-1 text-sm text-amber-100/70">
              {currentTier === "free"
                ? comingSoon
                  ? copy.paywallFreeNow
                  : copy.paywallFreeWithTutor
                : fill(copy.paywallOnPlan, {
                    plan: currentTier === "premium" ? PREMIUM : copy.paywallBasic
                  })}
            </p>
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={copy.close}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-amber-100/70"
            >
              ✕
            </button>
          ) : null}
        </div>

        <div className="mt-5 flex flex-col gap-3">
          {plans.map((p) => {
            const isCurrent = currentTier === p.id;
            return (
              <div
                key={p.id}
                className={`rounded-2xl border p-4 ${
                  p.highlight
                    ? "border-amber-300/40 bg-amber-400/5"
                    : "border-white/10 bg-black/20"
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-semibold text-white">{p.label}</span>
                  <span className="text-amber-100/80">
                    <span className="text-xl font-semibold text-white">{p.price}</span> {copy.paywallPerMonth}
                  </span>
                </div>
                <ul className="mt-2 flex flex-col gap-1 text-sm text-amber-50/80">
                  {p.features.map((f) => {
                    const pending = f.tutor === true && comingSoon;
                    return (
                      <li key={f.text} className={pending ? "text-amber-50/45" : undefined}>
                        {pending ? "·" : "✓"} {copy[f.text]}
                        {pending ? (
                          <span className="ml-1.5 inline-block whitespace-nowrap rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 align-middle text-[0.65rem] font-medium uppercase tracking-wide text-amber-200/90">
                            {copy.comingSoon}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <button
                  type="button"
                  onClick={() => void choose(p.id)}
                  disabled={busy !== null || isCurrent}
                  className={`mt-3 w-full rounded-2xl px-5 py-2.5 text-base font-semibold transition disabled:opacity-60 ${
                    p.highlight
                      ? "bg-amber-400 text-stone-950 hover:bg-amber-300"
                      : "border border-amber-300/30 bg-white/5 text-amber-100 hover:bg-white/10"
                  }`}
                >
                  {isCurrent
                    ? copy.paywallCurrentPlan
                    : busy === p.id
                      ? copy.paywallOpening
                      : fill(isPaid ? copy.paywallSwitchTo : copy.paywallGet, { plan: p.label })}
                </button>
              </div>
            );
          })}
        </div>

        {/* Add-on minute packs. Unlike every other tutor promise on this page,
            this one is not copy — it is a live Stripe charge, and the minutes
            it sells cannot be spent while /tutor is dark. So the block stays
            (it is how the packs come back, unchanged, with the flag) but the
            two buy buttons are withheld rather than labelled: a "coming soon"
            badge on a button that still charges $9.99 would be worse than no
            badge at all. The Stripe prices themselves are untouched. */}
        {isPaid && comingSoon ? (
          <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
            <p className="text-sm font-medium text-amber-100/90">
              {copy.paywallPacksSoon}{" "}
              <span className="ml-0.5 inline-block whitespace-nowrap rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 align-middle text-[0.65rem] font-medium uppercase tracking-wide text-amber-200/90">
                {copy.comingSoon}
              </span>
            </p>
            <p className="mt-2 text-xs text-amber-100/40">{copy.paywallPacksSoonBody}</p>
          </div>
        ) : null}

        {isPaid && !comingSoon ? (
          <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
            <p className="text-sm font-medium text-amber-100/90">{copy.paywallMoreMinutes}</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void buyPack("100")}
                disabled={busy !== null}
                className="flex-1 rounded-xl border border-amber-300/30 bg-white/5 px-3 py-2 text-sm text-amber-100 disabled:opacity-60"
              >
                {busy === "pack-100" ? copy.paywallOpening : "+100 min · $9.99"}
              </button>
              <button
                type="button"
                onClick={() => void buyPack("200")}
                disabled={busy !== null}
                className="flex-1 rounded-xl border border-amber-300/30 bg-white/5 px-3 py-2 text-sm text-amber-100 disabled:opacity-60"
              >
                {busy === "pack-200" ? copy.paywallOpening : "+200 min · $17.99"}
              </button>
            </div>
            {/* This sentence was "Packs add minutes for the rest of this
                month", which was true of the month-scoped `bonus_seconds` the
                packs used to credit and is false now. Tutor phase 2 made a
                pack a real purchase: it credits `profiles.pack_seconds`, which
                rolls over and never expires, and the meter spends the plan's
                rented minutes before it touches it. Saying so BEFORE the
                charge is cheaper than saying it after. */}
            <p className="mt-2 text-xs text-amber-100/40">{copy.paywallRollover}</p>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between text-xs text-amber-100/50">
          {isPaid ? (
            <button type="button" onClick={() => void openPortal()} className="underline-offset-2 hover:underline">
              {copy.paywallManageBilling}
            </button>
          ) : (
            <span />
          )}
          <button type="button" onClick={onSignOut} title={email} className="underline-offset-2 hover:underline">
            {copy.navSignOut}
          </button>
        </div>

        {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}
      </div>
    </main>
  );
}
