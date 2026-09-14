"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { authHeaders } from "@/lib/authClient";
import { isFounder } from "@/lib/release";
import { supabase } from "@/lib/supabase";

// v1 release gate (see lib/release.ts): wraps a held-back page. Founders get
// the real screen; everyone else — signed in or not — gets a friendly
// bilingual "coming soon" instead of a feature we're not ready to support
// (or, for /call, to pay for) at launch.
//
// ── What this gate is and isn't ────────────────────────────────────────────
// The founder check runs in the BROWSER, because that is where the Supabase
// session lives (lib/supabase.ts persists it client-side; a server component
// has no cookie to read). So this hides a screen; it does not defend one. The
// fence is on the routes that spend money, which re-ask the same question
// against a server-validated access token — see lib/spendGuard.ts and the
// callVisibleTo() check in app/api/call/realtime/route.ts.
//
// Which is also why `deny` exists. /video shows the "coming soon" card: you
// only reach it by opening the account menu, so a card is an answer to a
// question you asked. /call is different — its whole shape is a shared
// `/call?room=XYZ` link that lives in someone's messages, and a stranger who
// taps a forwarded one should land on TAOS proper, not on a card advertising
// a screen they will never get. They get bounced home instead.

export interface FounderGateProps {
  children: ReactNode;
  /**
   * True when the screen has shipped to everyone, which retires this gate.
   * Passed in (rather than read here) so the page owns its own release flag:
   * /call asks callEnabled(), /video has no flag at all.
   */
  publicRelease?: boolean;
  /** What a non-founder sees: the card, or a bounce to the home screen. */
  deny?: "coming-soon" | "home";
  /**
   * A route that can let in a signed-in non-founder the browser cannot
   * recognise — POSTed with the access token, 204 means yes, anything else
   * (including a network error) means no. /call passes /api/call/access so
   * its server-only test-pair allowlist reaches the page without entering the
   * bundle. Omitted, the gate is founders-only, exactly as before.
   */
  accessCheck?: string;
}

export function FounderGate({
  children,
  publicRelease = false,
  deny = "coming-soon",
  accessCheck
}: FounderGateProps): JSX.Element {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  // The server's answer, remembered per USER rather than per token. Supabase
  // refreshes the access token hourly and hands the gate a new session when it
  // does; keyed on the token, that refresh would re-ask, flash "Loading…" and
  // unmount a /call that is mid-conversation.
  const [serverAnswer, setServerAnswer] = useState<{ userId: string; allowed: boolean } | null>(
    null
  );

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

  const clientAllowed = publicRelease || isFounder(session?.user?.email);
  const userId = session?.user?.id ?? null;
  const asksServer = Boolean(accessCheck) && ready && !clientAllowed && userId !== null;

  useEffect(() => {
    if (!asksServer || !accessCheck || !userId) return;
    let active = true;
    (async () => {
      let allowed = false;
      try {
        const res = await fetch(accessCheck, {
          method: "POST",
          headers: await authHeaders(),
          cache: "no-store"
        });
        allowed = res.status === 204;
      } catch {
        // Fail closed: an unreachable check lets nobody in.
        allowed = false;
      }
      if (active) setServerAnswer({ userId, allowed });
    })();
    return () => {
      active = false;
    };
  }, [asksServer, accessCheck, userId]);

  const answered = asksServer && serverAnswer?.userId === userId;
  const allowed = clientAllowed || (answered && serverAnswer?.allowed === true);
  const settled = ready && (!asksServer || answered);

  // The bounce waits until the gate has its answer: firing it on the first
  // render would send a founder home every time, because getSession() has not
  // answered yet — and a test pair too, while the server check is in flight.
  useEffect(() => {
    if (settled && !allowed && deny === "home") router.replace("/");
  }, [settled, allowed, deny, router]);

  if (!settled) {
    return (
      <main className="flex min-h-screen items-center justify-center text-amber-100/60">
        Loading…
      </main>
    );
  }

  if (allowed) {
    return <>{children}</>;
  }

  if (deny === "home") {
    // The redirect above is already in flight; this is the frame in between.
    return (
      <main className="flex min-h-screen items-center justify-center text-amber-100/60">
        Loading…
      </main>
    );
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
