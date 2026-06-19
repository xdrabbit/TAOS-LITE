"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

// Shared account for the two of you. No email is ever sent; the passcode is the
// password, verified by Supabase, and Row-Level Security protects the history.
const SHARED_EMAIL = "taos@ritualstack.io";

export function SignIn(): JSX.Element {
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: SHARED_EMAIL,
        password: passcode
      });
      if (error) {
        setError("Incorrect passcode · Código incorrecto");
      }
      // On success, AppShell's auth listener swaps in the app.
    } catch {
      setError("Sign-in failed · No se pudo entrar");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin }
    });
    if (error) setError("Google sign-in failed. Try again.");
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.3)]">
        <h1 className="text-2xl font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
        <p className="mt-1 text-sm text-amber-100/60">
          Enter the passcode to open your translator.
          <br />
          Escribe el código para abrir tu traductor.
        </p>

        <button
          type="button"
          onClick={() => void google()}
          className="mt-6 flex w-full items-center justify-center gap-3 rounded-2xl border border-white/15 bg-white px-5 py-3 text-base font-medium text-stone-800 transition hover:bg-stone-100"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
            <path fill="#EA4335" d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 6.68 9.14 4.75 12 4.75z" />
          </svg>
          Continue with Google
        </button>

        <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-amber-100/30">
          <span className="h-px flex-1 bg-white/10" /> or passcode <span className="h-px flex-1 bg-white/10" />
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="text-xs uppercase tracking-[0.18em] text-amber-100/50">
            Passcode · Código
          </label>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="••••••••"
            className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-lg text-white outline-none focus:border-amber-300/50"
          />
          <button
            type="submit"
            disabled={busy || !passcode}
            className="mt-2 rounded-2xl bg-amber-400 px-5 py-3 text-lg font-semibold text-stone-950 transition hover:bg-amber-300 disabled:opacity-60"
          >
            {busy ? "Opening… · Abriendo…" : "Enter · Entrar"}
          </button>
        </form>

        {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}
      </div>
    </main>
  );
}
