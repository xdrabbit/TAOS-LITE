"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { PRACTICA_NOT_ENABLED, practicaVisibleTo } from "@/lib/practica/access";
import { supabase } from "@/lib/supabase";

export function PracticaGate({
  configured,
  children
}: {
  configured: boolean;
  children: ReactNode;
}): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!configured) return;
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [configured]);

  if (!configured || (ready && !practicaVisibleTo(session?.user.email, true))) {
    return (
      <main className="grid min-h-screen place-items-center bg-stone-950 px-6 text-center text-amber-100">
        <p>{PRACTICA_NOT_ENABLED}</p>
      </main>
    );
  }

  if (!ready) {
    return (
      <main className="grid min-h-screen place-items-center bg-stone-950 text-amber-100/60">
        <p>Loading…</p>
      </main>
    );
  }

  return <>{children}</>;
}
