"use client";

import { useState } from "react";
import { COMING_SOON, tutorComingSoon } from "@/lib/release";
import { ROLLOVER_NOTE } from "@/lib/tutor/meterCopy";
import { startCheckout, startPackCheckout, supabase, type Tier } from "@/lib/supabase";

interface Plan {
  id: "basic" | "premium";
  name: string;
  price: string;
  features: { text: string; tutor?: boolean }[];
  highlight?: boolean;
}

// This is the screen with the Stripe button on it, so it is the one that has
// to be exactly true. Tutor is gated off (lib/release.ts): the minutes, the
// drills and the progress tracking all live behind /tutor, so each is flagged
// `tutor: true` and renders as pending rather than as something the charge
// buys today. Same flag as the nav — when tutor returns, so does the ✓.
const PLANS: Plan[] = [
  {
    id: "basic",
    name: "Basic",
    price: "$5.99",
    features: [
      { text: "Unlimited translation" },
      { text: "45 tutor minutes / month", tutor: true },
      { text: "Drills + progress", tutor: true }
    ]
  },
  {
    id: "premium",
    name: "Premium",
    price: "$19.99",
    features: [
      { text: "Unlimited translation" },
      { text: "200 tutor minutes / month", tutor: true },
      { text: "Drills + progress", tutor: true }
    ],
    highlight: true
  }
];

export function Paywall({
  email,
  currentTier = "free",
  onClose,
  onSignOut
}: {
  email: string;
  currentTier?: Tier;
  onClose?: () => void;
  onSignOut: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPaid = currentTier === "basic" || currentTier === "premium";
  const comingSoon = tutorComingSoon();

  // Free users start a new checkout; existing subscribers switch plans in the
  // Stripe billing portal (avoids creating a second subscription).
  async function choose(plan: "basic" | "premium") {
    setBusy(plan);
    setError(null);
    try {
      if (isPaid) {
        await openPortal();
      } else {
        await startCheckout(plan);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout.");
      setBusy(null);
    }
  }

  async function buyPack(pack: "100" | "200") {
    setBusy(`pack-${pack}`);
    setError(null);
    try {
      await startPackCheckout(pack);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout.");
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    setError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Please sign in again.");
      const res = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      const payload = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !payload.url) throw new Error(payload.error || "Could not open billing.");
      window.location.href = payload.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(null);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-8">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.3)]">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-amber-200">Choose your plan</h1>
            <p className="mt-1 text-sm text-amber-100/70">
              {currentTier === "free"
                ? comingSoon
                  ? "You're on the free plan (25 translations / month). Paid plans lift that limit today."
                  : "You're on the free plan (25 translations + 15 tutor min / month)."
                : `You're on ${currentTier === "premium" ? "Premium" : "Basic"}.`}
            </p>
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-amber-100/70"
            >
              ✕
            </button>
          ) : null}
        </div>

        <div className="mt-5 flex flex-col gap-3">
          {PLANS.map((p) => {
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
                  <span className="text-lg font-semibold text-white">{p.name}</span>
                  <span className="text-amber-100/80">
                    <span className="text-xl font-semibold text-white">{p.price}</span> / mo
                  </span>
                </div>
                <ul className="mt-2 flex flex-col gap-1 text-sm text-amber-50/80">
                  {p.features.map((f) => {
                    const pending = f.tutor === true && comingSoon;
                    return (
                      <li key={f.text} className={pending ? "text-amber-50/45" : undefined}>
                        {pending ? "·" : "✓"} {f.text}
                        {pending ? (
                          <span className="ml-1.5 inline-block whitespace-nowrap rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 align-middle text-[0.65rem] font-medium uppercase tracking-wide text-amber-200/90">
                            {COMING_SOON}
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
                    ? "Current plan"
                    : busy === p.id
                      ? "Opening…"
                      : isPaid
                        ? `Switch to ${p.name}`
                        : `Get ${p.name}`}
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
              Add-on tutor minute packs{" "}
              <span className="ml-0.5 inline-block whitespace-nowrap rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 align-middle text-[0.65rem] font-medium uppercase tracking-wide text-amber-200/90">
                {COMING_SOON}
              </span>
            </p>
            <p className="mt-2 text-xs text-amber-100/40">
              The +100 and +200 minute packs go on sale when the tutor arrives. They never expire —
              pack minutes roll over, while a plan&apos;s minutes reset monthly. Your plan&apos;s
              unlimited translation is unaffected.
            </p>
          </div>
        ) : null}

        {isPaid && !comingSoon ? (
          <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
            <p className="text-sm font-medium text-amber-100/90">Need more tutor minutes this month?</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void buyPack("100")}
                disabled={busy !== null}
                className="flex-1 rounded-xl border border-amber-300/30 bg-white/5 px-3 py-2 text-sm text-amber-100 disabled:opacity-60"
              >
                {busy === "pack-100" ? "Opening…" : "+100 min · $9.99"}
              </button>
              <button
                type="button"
                onClick={() => void buyPack("200")}
                disabled={busy !== null}
                className="flex-1 rounded-xl border border-amber-300/30 bg-white/5 px-3 py-2 text-sm text-amber-100 disabled:opacity-60"
              >
                {busy === "pack-200" ? "Opening…" : "+200 min · $17.99"}
              </button>
            </div>
            {/* This sentence was "Packs add minutes for the rest of this
                month", which was true of the month-scoped `bonus_seconds` the
                packs used to credit and is false now. Tutor phase 2 made a
                pack a real purchase: it credits `profiles.pack_seconds`, which
                rolls over and never expires, and the meter spends the plan's
                rented minutes before it touches it. Saying so BEFORE the
                charge is cheaper than saying it after. */}
            <p className="mt-2 text-xs text-amber-100/40">{ROLLOVER_NOTE.en}</p>
            <p className="text-xs text-amber-100/30">{ROLLOVER_NOTE.es}</p>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between text-xs text-amber-100/50">
          {isPaid ? (
            <button type="button" onClick={() => void openPortal()} className="underline-offset-2 hover:underline">
              Manage billing
            </button>
          ) : (
            <span />
          )}
          <button type="button" onClick={onSignOut} title={email} className="underline-offset-2 hover:underline">
            Sign out
          </button>
        </div>

        {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}
      </div>
    </main>
  );
}
