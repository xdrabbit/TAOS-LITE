"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong. Try again.";
}

export function SignIn(): JSX.Element {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: true }
      });
      if (error) throw error;
      setStage("code");
      setInfo("Check your email for a 6-digit code and enter it below.");
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: "email"
      });
      if (error) throw error;
      // AppShell's auth listener takes it from here.
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.3)]">
        <h1 className="text-2xl font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
        <p className="mt-1 text-sm text-amber-100/60">
          Sign in to keep a private, encrypted history of your translations.
        </p>

        {stage === "email" ? (
          <form onSubmit={sendCode} className="mt-6 flex flex-col gap-3">
            <label className="text-xs uppercase tracking-[0.18em] text-amber-100/50">Email</label>
            <input
              type="email"
              required
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-lg text-white outline-none focus:border-amber-300/50"
            />
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="mt-2 rounded-2xl bg-amber-400 px-5 py-3 text-lg font-semibold text-stone-950 transition hover:bg-amber-300 disabled:opacity-60"
            >
              {busy ? "Sending…" : "Email me a code"}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} className="mt-6 flex flex-col gap-3">
            <label className="text-xs uppercase tracking-[0.18em] text-amber-100/50">
              6-digit code
            </label>
            <input
              type="text"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="123456"
              maxLength={6}
              className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-center text-2xl tracking-[0.4em] text-white outline-none focus:border-amber-300/50"
            />
            <button
              type="submit"
              disabled={busy || code.trim().length < 6}
              className="mt-2 rounded-2xl bg-amber-400 px-5 py-3 text-lg font-semibold text-stone-950 transition hover:bg-amber-300 disabled:opacity-60"
            >
              {busy ? "Verifying…" : "Verify & sign in"}
            </button>
            <button
              type="button"
              onClick={() => {
                setStage("email");
                setCode("");
                setError(null);
                setInfo(null);
              }}
              className="text-sm text-amber-100/60 underline-offset-2 hover:underline"
            >
              Use a different email
            </button>
          </form>
        )}

        {info ? <p className="mt-4 text-sm text-emerald-200/80">{info}</p> : null}
        {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}
      </div>
    </main>
  );
}
