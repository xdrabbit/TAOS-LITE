"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

export function Paywall({
  email,
  trialExpired,
  onSignOut
}: {
  email: string;
  trialExpired: boolean;
  onSignOut: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(path: "checkout" | "portal") {
    setBusy(true);
    setError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Please sign in again.");
      const res = await fetch(`/api/stripe/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      const payload = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !payload.url) throw new Error(payload.error || "Could not start checkout.");
      window.location.href = payload.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.3)]">
        <h1 className="text-2xl font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
        <p className="mt-1 text-sm text-amber-100/70">
          {trialExpired ? "Your free trial has ended." : "Subscribe to keep translating."}
        </p>

        <ul className="mt-5 flex flex-col gap-2 text-sm text-amber-50/80">
          <li>✓ Unlimited live translation, any language pair</li>
          <li>✓ Spoken playback (natural voices)</li>
          <li>✓ Private, saved history</li>
        </ul>

        <div className="mt-5 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-center">
          <span className="text-2xl font-semibold text-white">$7.99</span>
          <span className="text-sm text-amber-100/60"> / month</span>
        </div>

        <button
          type="button"
          onClick={() => void go("checkout")}
          disabled={busy}
          className="mt-5 w-full rounded-2xl bg-amber-400 px-5 py-3 text-lg font-semibold text-stone-950 transition hover:bg-amber-300 disabled:opacity-60"
        >
          {busy ? "Opening…" : "Subscribe"}
        </button>

        <div className="mt-4 flex items-center justify-between text-xs text-amber-100/50">
          <button type="button" onClick={() => void go("portal")} className="underline-offset-2 hover:underline">
            Manage billing
          </button>
          <button type="button" onClick={onSignOut} title={email} className="underline-offset-2 hover:underline">
            Sign out
          </button>
        </div>

        {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}
      </div>
    </main>
  );
}
