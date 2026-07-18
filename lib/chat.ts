"use client";

import { supabase } from "@/lib/supabase";

// Client helpers for the tier-1 private chat. Reads go straight through
// supabase-js (RLS scopes everything to threads the user belongs to); sends go
// through POST /api/chat/send so translation happens server-side and the
// message + translation land as one row. Live delivery is a postgres_changes
// subscription on the messages table (RLS applies to the stream too).

export interface ChatMessageRow {
  id: string;
  thread_id: string;
  sender_id: string;
  kind: "text" | "voice";
  audio_path: string | null;
  body: string;
  body_translated: string | null;
  source_lang: string | null;
  target_lang: string | null;
  created_at: string;
  read_at: string | null;
}

export interface ChatThreadInfo {
  threadId: string;
  myUserId: string;
  myLang: string;
  partnerLang: string | null;
}

// The user's first (for Tom & Liz: only) chat thread, or null when they are
// not a member of any thread.
export async function getChatThread(): Promise<ChatThreadInfo | null> {
  const { data: auth } = await supabase.auth.getUser();
  const myUserId = auth.user?.id;
  if (!myUserId) return null;

  const { data, error } = await supabase
    .from("taos_lite_chat_members")
    .select("thread_id, user_id, lang")
    .order("created_at", { ascending: true });
  if (error || !data?.length) return null;

  const mine = data.find((m) => m.user_id === myUserId);
  if (!mine) return null;
  const partner = data.find((m) => m.thread_id === mine.thread_id && m.user_id !== myUserId);
  return {
    threadId: mine.thread_id,
    myUserId,
    myLang: mine.lang,
    partnerLang: partner?.lang ?? null
  };
}

export async function listMessages(threadId: string, limit = 200): Promise<ChatMessageRow[]> {
  const { data, error } = await supabase
    .from("taos_lite_chat_messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as ChatMessageRow[]).reverse();
}

export async function sendMessage(threadId: string, body: string): Promise<ChatMessageRow> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const res = await fetch("/api/chat/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ threadId, body })
  });
  const payload = (await res.json().catch(() => ({}))) as {
    message?: ChatMessageRow;
    error?: string;
  };
  if (!res.ok || !payload.message) {
    throw new Error(payload.error || "Could not send the message.");
  }
  return payload.message;
}

export async function sendVoiceMessage(
  threadId: string,
  blob: Blob,
  mimeType: string
): Promise<ChatMessageRow> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const form = new FormData();
  form.append("threadId", threadId);
  form.append("audio", new File([blob], "voice", { type: mimeType }));
  const res = await fetch("/api/chat/voice", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  const payload = (await res.json().catch(() => ({}))) as {
    message?: ChatMessageRow;
    error?: string;
  };
  if (!res.ok || !payload.message) {
    throw new Error(payload.error || "Could not send the voice message.");
  }
  return payload.message;
}

// Short-lived signed URL for a voice note's audio (storage RLS restricts this
// to members of the thread in the path).
export async function getVoiceUrl(audioPath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from("chat-voice")
    .createSignedUrl(audioPath, 3600);
  if (error || !data?.signedUrl) throw error ?? new Error("Could not load the audio.");
  return data.signedUrl;
}

// Live INSERT stream for the thread. Returns an unsubscribe function.
export function subscribeMessages(
  threadId: string,
  onInsert: (row: ChatMessageRow) => void
): () => void {
  const channel = supabase
    .channel(`taos-chat-${threadId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "taos_lite_chat_messages",
        filter: `thread_id=eq.${threadId}`
      },
      (payload) => onInsert(payload.new as ChatMessageRow)
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

// Stamp everything the partner sent as read. Best-effort; RLS restricts the
// update to messages in my threads that I did not send.
export async function markThreadRead(threadId: string): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const myUserId = auth.user?.id;
  if (!myUserId) return;
  await supabase
    .from("taos_lite_chat_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("thread_id", threadId)
    .neq("sender_id", myUserId)
    .is("read_at", null);
}
