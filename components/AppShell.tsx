"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getProfile, supabase, type Profile } from "@/lib/supabase";
import { SignIn } from "./SignIn";
import { TranslatorShell } from "./TranslatorShell";

export function AppShell(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  const refreshProfile = useCallback(async () => {
    const p = await getProfile();
    setProfile(p);
  }, []);

  useEffect(() => {
    let active = true;

    async function load(next: Session | null) {
      if (next) await refreshProfile();
      else setProfile(null);
      if (active) setReady(true);
    }

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      void load(data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      void load(next);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [refreshProfile]);

  // Returning from Stripe Checkout: the webhook updates the profile a moment
  // later, so re-poll briefly so the app unlocks without a manual refresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("checkout")) return;
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      void refreshProfile();
      if (n >= 5) {
        window.clearInterval(id);
        window.history.replaceState({}, "", window.location.pathname);
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [refreshProfile]);

  function signOut() {
    void supabase.auth.signOut();
  }

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

  // Everyone signed in enters at their tier (free included). Upgrade prompts are
  // shown inline by TranslatorShell / TutorShell when a quota runs out.
  return (
    <TranslatorShell email={session.user.email ?? ""} profile={profile} onSignOut={signOut} />
  );
}
