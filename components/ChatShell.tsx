"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { SignIn } from "./SignIn";
import {
  getChatThread,
  listMessages,
  markThreadRead,
  sendMessage,
  subscribeMessages,
  type ChatMessageRow,
  type ChatThreadInfo
} from "@/lib/chat";

// ── /chat: private translated messages ──────────────────────────────────────
// Tier 1 of the private message app: one thread between Tom and Liz. Each
// message is stored in the sender's language AND auto-translated into the
// partner's (server-side, /api/chat/send), so each person reads in their own
// language with the original a glance away. Delivery is instant while the app
// is open (Supabase Realtime); push notifications are tier 2.

interface PendingMessage {
  tempId: string;
  body: string;
  failed: boolean;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatDay(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function ChatShell(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [thread, setThread] = useState<ChatThreadInfo | null>(null);
  const [threadMissing, setThreadMissing] = useState(false);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const nextTempIdRef = useRef(1);

  // Auth gating — same listener pattern as AppShell.
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

  // Load the thread + history, subscribe to live inserts.
  useEffect(() => {
    if (!session) {
      setThread(null);
      setMessages([]);
      return;
    }
    let active = true;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      const t = await getChatThread();
      if (!active) return;
      if (!t) {
        setThreadMissing(true);
        return;
      }
      setThread(t);
      setThreadMissing(false);
      try {
        const rows = await listMessages(t.threadId);
        if (!active) return;
        setMessages(rows);
      } catch {
        if (active) setError("Could not load messages.");
      }
      void markThreadRead(t.threadId);

      unsubscribe = subscribeMessages(t.threadId, (row) => {
        setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
        if (row.sender_id !== t.myUserId) void markThreadRead(t.threadId);
      });
    })();

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [session]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || !thread) return;
    setDraft("");
    setError(null);
    const tempId = `tmp-${nextTempIdRef.current++}`;
    setPending((p) => [...p, { tempId, body, failed: false }]);
    try {
      const row = await sendMessage(thread.threadId, body);
      setPending((p) => p.filter((m) => m.tempId !== tempId));
      setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
    } catch (e) {
      setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, failed: true } : m)));
      setError(e instanceof Error ? e.message : "Could not send the message.");
    }
  }, [draft, thread]);

  const retryPending = useCallback(
    async (tempId: string) => {
      const msg = pending.find((m) => m.tempId === tempId);
      if (!msg || !thread) return;
      setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, failed: false } : m)));
      setError(null);
      try {
        const row = await sendMessage(thread.threadId, msg.body);
        setPending((p) => p.filter((m) => m.tempId !== tempId));
        setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
      } catch (e) {
        setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, failed: true } : m)));
        setError(e instanceof Error ? e.message : "Could not send the message.");
      }
    },
    [pending, thread]
  );

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center text-amber-100/60">
        Loading…
      </main>
    );
  }
  if (!session) {
    return <SignIn />;
  }

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex h-[calc(100dvh-1.5rem)] max-w-md flex-col gap-3">
        <header className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
          <a
            href="/"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-amber-100/80"
          >
            ← Home
          </a>
        </header>

        <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
          Private chat · Chat privado
        </div>

        {threadMissing ? (
          <div className="rounded-2xl border border-amber-300/20 bg-amber-400/10 p-4 text-sm text-amber-100/80">
            This account isn&apos;t part of a chat yet. Sign in with your own Google account (not
            the shared passcode account).
          </div>
        ) : null}

        {/* Messages */}
        <div
          ref={listRef}
          className="flex-1 space-y-2 overflow-y-auto rounded-2xl border border-white/10 bg-white/5 p-3"
        >
          {messages.length === 0 && pending.length === 0 ? (
            <div className="pt-8 text-center text-sm text-amber-100/40">
              No messages yet — say hi · Aún no hay mensajes — saluda
            </div>
          ) : null}
          {messages.map((m, i) => {
            const mine = m.sender_id === thread?.myUserId;
            // What the viewer reads first: their own words for their messages,
            // the translation (when present) for the partner's.
            const primary = mine ? m.body : m.body_translated ?? m.body;
            const secondary = mine ? m.body_translated : m.body_translated ? m.body : null;
            const newDay = i === 0 || dayKey(messages[i - 1].created_at) !== dayKey(m.created_at);
            return (
              <div key={m.id}>
                {newDay ? (
                  <div className="py-1 text-center text-[11px] uppercase tracking-widest text-amber-100/30">
                    {formatDay(m.created_at)}
                  </div>
                ) : null}
                <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                      mine
                        ? "rounded-br-md bg-amber-400/90 text-stone-950"
                        : "rounded-bl-md border border-white/10 bg-stone-950/60 text-amber-50"
                    }`}
                  >
                    <div className="whitespace-pre-wrap break-words text-[15px] leading-snug">
                      {primary}
                    </div>
                    {secondary ? (
                      <div
                        className={`mt-1 whitespace-pre-wrap break-words border-t pt-1 text-xs ${
                          mine
                            ? "border-stone-950/20 text-stone-950/60"
                            : "border-white/10 text-amber-100/50"
                        }`}
                      >
                        {secondary}
                      </div>
                    ) : null}
                    <div
                      className={`mt-1 text-right text-[10px] ${
                        mine ? "text-stone-950/50" : "text-amber-100/30"
                      }`}
                    >
                      {formatTime(m.created_at)}
                      {mine && m.read_at ? " ✓✓" : ""}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {pending.map((p) => (
            <div key={p.tempId} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-amber-400/50 px-3 py-2 text-stone-950">
                <div className="whitespace-pre-wrap break-words text-[15px] leading-snug">
                  {p.body}
                </div>
                <div className="mt-1 text-right text-[10px] text-stone-950/60">
                  {p.failed ? (
                    <button
                      type="button"
                      onClick={() => void retryPending(p.tempId)}
                      className="font-semibold underline"
                    >
                      failed — tap to retry
                    </button>
                  ) : (
                    "sending…"
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {error ? (
          <div className="rounded-2xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        ) : null}

        {/* Composer */}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={thread?.myLang === "es" ? "Escribe un mensaje…" : "Type a message…"}
            rows={1}
            className="max-h-32 min-h-[2.75rem] flex-1 resize-none rounded-2xl border border-white/10 bg-stone-950/60 px-4 py-2.5 text-[15px] text-amber-50 placeholder:text-amber-100/30"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!draft.trim() || !thread}
            className="rounded-2xl bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-stone-950 transition disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </main>
  );
}
