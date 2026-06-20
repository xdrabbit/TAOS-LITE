"use client";

import { useState } from "react";
import { startCheckout, supabase, type Tier } from "@/lib/supabase";

interface Plan {
  id: "basic" | "premium";
  name: string;
  price: string;
  features: string[];
  highlight?: boolean;
}

const PLANS: Plan[] = [
  {
    id: "basic",
    name: "Basic",
    price: "$5.99",
    features: ["Unlimited translation", "45 tutor minutes / month", "Drills + progress"]
  },
  {
    id: "premium",
    name: "Premium",
    price: "$19.99",
    features: ["Unlimited translation", "200 tutor minutes / month", "Drills + progress"],
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
                ? "You're on the free plan (25 translations + 15 tutor min / month)."
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
                  {p.features.map((f) => (
                    <li key={f}>✓ {f}</li>
                  ))}
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

        <p className="mt-3 text-center text-xs text-amber-100/40">
          Need more than 200 min? Add-on packs are coming soon.
        </p>

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
