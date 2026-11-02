"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { walkieGateState } from "@/lib/walkie/flag";
import { SignIn } from "@/components/SignIn";

// /taokie's gate — DemoGate (components/demo/DemoGate.tsx) with the flag
// swapped. Runs in the browser off the client-held session, so it HIDES the
// screen; the fence is lib/walkie/guard.ts on every route. It tells "flag
// off" from "signed out" because the second has a one-tap fix.

function Card({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="flex max-w-sm flex-col items-center gap-4 rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
        {children}
      </div>
    </main>
  );
}

export function WalkieGate({ enabled, children }: { enabled: boolean; children: ReactNode }): JSX.Element {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const state = walkieGateState({
    enabled,
    ready,
    email: session?.user?.email,
    signedIn: Boolean(session)
  });

  useEffect(() => {
    if (state === "denied") router.replace("/");
  }, [state, router]);

  if (state === "open") return <>{children}</>;

  if (state === "disabled") {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-amber-200">Not enabled · No está activado</h1>
        <p className="text-sm text-amber-100/70">
          Taokie is switched off on this deployment.
          <br />
          {/* pendiente de revisión por Liz */}
          Taokie está desactivado aquí.
        </p>
        <a
          href="/"
          className="rounded-2xl bg-amber-400 px-5 py-2.5 text-sm font-semibold text-stone-950 transition active:scale-[0.99]"
        >
          ← Back to TAOS · Volver
        </a>
      </Card>
    );
  }

  if (state === "sign-in") {
    if (showSignIn) return <SignIn redirectPath="/taokie" title="Taokie" />;
    return (
      <Card>
        <h1 className="text-xl font-semibold text-amber-200">Inicia sesión · Sign in</h1>
        <p className="text-sm text-amber-100/70">
          Sign in with a founder account to use Taokie.
          <br />
          {/* pendiente de revisión por Liz */}
          Inicia sesión con una cuenta de fundador para usar Taokie.
        </p>
        <button
          type="button"
          onClick={() => setShowSignIn(true)}
          className="rounded-2xl bg-amber-400 px-5 py-2.5 text-sm font-semibold text-stone-950 transition active:scale-[0.99]"
        >
          Inicia sesión · Sign in
        </button>
      </Card>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center text-amber-100/60">Loading…</main>
  );
}
