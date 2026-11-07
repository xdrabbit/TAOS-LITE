"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { reviewGateState } from "@/lib/review/flag";
import { SignIn } from "@/components/SignIn";
import { copyFor } from "@/lib/chrome/copy";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";

// /review's gate — WalkieGate (components/walkie/WalkieGate.tsx) without the
// flag. Runs in the browser off the client-held session, so it HIDES the
// screen; the fence is lib/review/guard.ts on every route, which answers a
// non-founder with 404. A signed-in non-founder sees the same answer here —
// a plain "Not found" card, no advert — and is not bounced anywhere.
//
// The cards read in the phone owner's language, from the same `mine` the
// shell behind them uses (lib/chrome/copy.ts), rather than the doubled
// "Inicia sesión · Sign in" the other gates still carry. Liz is the reader
// this page was built for, and the gate is the first thing she sees.

function Card({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="flex max-w-sm flex-col items-center gap-4 rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
        {children}
      </div>
    </main>
  );
}

export function ReviewGate({ children }: { children: ReactNode }): JSX.Element {
  const { mine } = useLanguagePair();
  const s = copyFor(mine);
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

  const state = reviewGateState({ ready, email: session?.user?.email, signedIn: Boolean(session) });

  if (state === "open") return <>{children}</>;

  if (state === "denied") {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-amber-200">404 · {s.reviewNotFound}</h1>
        <a
          href="/"
          className="rounded-2xl bg-amber-400 px-5 py-2.5 text-sm font-semibold text-stone-950 transition active:scale-[0.99]"
        >
          {s.reviewBackHome}
        </a>
      </Card>
    );
  }

  if (state === "sign-in") {
    if (showSignIn) return <SignIn redirectPath="/review" title={s.reviewTitle} />;
    return (
      <Card>
        <h1 className="text-xl font-semibold text-amber-200">{s.reviewSignIn}</h1>
        <p className="text-sm text-amber-100/70">{s.reviewSignInHint}</p>
        <button
          type="button"
          onClick={() => setShowSignIn(true)}
          className="rounded-2xl bg-amber-400 px-5 py-2.5 text-sm font-semibold text-stone-950 transition active:scale-[0.99]"
        >
          {s.reviewSignIn}
        </button>
      </Card>
    );
  }

  return <main className="flex min-h-screen items-center justify-center text-amber-100/60">{s.reviewLoading}</main>;
}
