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

  return (
    <main className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.3)]">
        <h1 className="text-2xl font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
        <p className="mt-1 text-sm text-amber-100/60">
          Enter the passcode to open your translator.
          <br />
          Escribe el código para abrir tu traductor.
        </p>

        <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
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
