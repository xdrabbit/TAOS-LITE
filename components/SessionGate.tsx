"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { SignIn } from "./SignIn";

// Sign-in gate for the screens that spend money.
//
// The 8/13 field report that shaped VisionShell said it first: a signed-out
// visitor must see SignIn, not a click-time "Please sign in again". /vision,
// /video and /chat each learned that separately and each grew its own copy of
// this listener; /live, /tabletop and /translate never did, because until 8/19
// their routes let a stranger through and the screens genuinely worked signed
// out. Closing that hole (lib/spendGuard.ts) is what makes the gate necessary
// here — without it those three would look fine and 401 on first use, which is
// the exact bug the field report was about.
//
// The sibling of <FounderGate>, and deliberately the same shape: wrap the page,
// not the shell, so the shell's own hooks never run for someone who is only
// going to be asked to sign in. FounderGate answers "may this ACCOUNT see it";
// this answers "is there an account at all". A held-back screen wants both, and
// FounderGate already implies this one.
//
// Not retrofitted onto the three shells that rolled their own — they work, and
// a hotfix is the wrong PR to refactor them in. If a fourth needs it, use this.

export function SessionGate({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

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

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center text-amber-100/60">
        Loading…
      </main>
    );
  }

  if (!session) return <SignIn />;

  return <>{children}</>;
}
