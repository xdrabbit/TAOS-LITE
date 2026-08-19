"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { joinChatWithToken } from "@/lib/chat";
import {
  CHAT_JOIN_BAD_LINK,
  CHAT_JOIN_BLURB,
  CHAT_JOIN_BUSY,
  CHAT_JOIN_SIGNED_OUT,
  CHAT_JOIN_TITLE,
  invitePath,
  isInviteToken
} from "@/lib/chatInvite";
import { supabase } from "@/lib/supabase";
import { SignIn } from "./SignIn";

// The other end of the invite link: what a QR code opens.
//
// Three states and no fourth:
//   signed out — the invitation, and a sign-in that comes BACK HERE. The
//                token is in the path, so the return address has to carry the
//                path (lib/authRedirect.ts, second argument). A sign-in that
//                lands on the home screen loses the invite, which is the same
//                dead end this whole change is about, one step further along.
//   signed in  — redeem, then go straight to /chat. No "you're in, tap here";
//                the person came to have a conversation.
//   refused    — say what is wrong with the LINK. Never with their account,
//                and never "sign in" to somebody who is signed in.
export function ChatJoinShell({ token }: { token: string }): JSX.Element {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Redeeming twice would burn the token on the first attempt and then report
  // "already used" on the second — a self-inflicted failure, and React in
  // development runs effects twice on purpose. So the attempt is guarded by a
  // ref, not by state.
  const attempted = useRef(false);

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

  const join = useCallback(async () => {
    try {
      await joinChatWithToken(token);
      // replace(), not push(): the invite is spent, and Back should be the
      // page before the link, not a token that now answers "already used".
      router.replace("/chat");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : CHAT_JOIN_BAD_LINK);
    }
  }, [token, router]);

  useEffect(() => {
    if (!ready || !session || attempted.current) return;
    if (!isInviteToken(token)) {
      setError(CHAT_JOIN_BAD_LINK);
      return;
    }
    attempted.current = true;
    void join();
  }, [ready, session, token, join]);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center text-amber-100/60">
        Loading…
      </main>
    );
  }

  if (!session) {
    return (
      <SignIn
        redirectPath={invitePath(token)}
        title={CHAT_JOIN_TITLE}
        blurb={`${CHAT_JOIN_BLURB} ${CHAT_JOIN_SIGNED_OUT}`}
      />
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-6 text-center shadow-[0_24px_80px_rgba(0,0,0,0.3)]">
        <h1 className="text-xl font-semibold tracking-tight text-amber-200">{CHAT_JOIN_TITLE}</h1>
        {error ? (
          <>
            <p className="mt-3 text-sm leading-snug text-rose-300">{error}</p>
            <a
              href="/chat"
              className="mt-5 inline-block w-full rounded-2xl bg-amber-400 px-5 py-3 text-base font-semibold text-stone-950"
            >
              Go to chat · Ir al chat
            </a>
          </>
        ) : (
          <p className="mt-3 text-sm text-amber-100/60">{CHAT_JOIN_BUSY}</p>
        )}
      </div>
    </main>
  );
}
