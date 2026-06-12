"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { SignIn } from "./SignIn";
import { TranslatorShell } from "./TranslatorShell";

export function AppShell(): JSX.Element {
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
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-amber-200/70">Loading…</p>
      </main>
    );
  }

  if (!session) {
    return <SignIn />;
  }

  return (
    <TranslatorShell
      email={session.user.email ?? ""}
      onSignOut={() => {
        void supabase.auth.signOut();
      }}
    />
  );
}
