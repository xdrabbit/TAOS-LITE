"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { isFounder } from "@/lib/release";
import { supabase } from "@/lib/supabase";

// v1 release gate (see lib/release.ts): wraps a held-back page. Founders get
// the real screen; everyone else — signed in or not — gets a friendly
// bilingual "coming soon" instead of a feature we're not ready to support
// (or, for /call, to pay for) at launch.

export function FounderGate({ children }: { children: ReactNode }): JSX.Element {
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

  if (isFounder(session?.user?.email)) {
    return <>{children}</>;
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="flex max-w-sm flex-col items-center gap-4 rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
        <span className="text-4xl" aria-hidden="true">
          🔜
        </span>
        <h1 className="text-xl font-semibold text-amber-200">
          Coming soon · Próximamente
        </h1>
        <p className="text-sm text-amber-100/70">
          This part of TAOS is still being polished for release.
          <br />
          Esta parte de TAOS aún se está puliendo para su lanzamiento.
        </p>
        <a
          href="/"
          className="rounded-2xl bg-amber-400 px-5 py-2.5 text-sm font-semibold text-stone-950 transition active:scale-[0.99]"
        >
          ← Back to TAOS · Volver
        </a>
      </div>
    </main>
  );
}
