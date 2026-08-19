"use client";

import type { ChatThreadSummary } from "@/lib/chatThreads";
import { readStoredPair } from "@/lib/translate/pair";
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

export interface ChatThreadList {
  myUserId: string;
  threads: ChatThreadSummary[];
}

/**
 * Every chat this account is in, newest first.
 *
 * This replaced `getChatThread()`, which read the members table directly and
 * answered with the FIRST membership it found — the line that made /chat a
 * one-chat app and that /api/chat/join then had to apologise for ("TAOS holds
 * one at a time"). The list goes through a route rather than supabase-js for
 * one reason: a row is labelled with the other person's display name, and that
 * lives in auth.users, which no browser key may read. See the route.
 */
export async function listChatThreads(): Promise<ChatThreadList> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const res = await fetch("/api/chat/threads", {
    headers: { Authorization: `Bearer ${token}` }
  });
  const payload = (await res.json().catch(() => ({}))) as Partial<ChatThreadList> & {
    error?: string;
  };
  if (!res.ok || !payload.myUserId || !Array.isArray(payload.threads)) {
    throw new Error(payload.error || "Could not open your chats.");
  }
  return { myUserId: payload.myUserId, threads: payload.threads };
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

/**
 * Change MY language in this thread. The partner's is set on their own phone
 * — see app/api/chat/language/route.ts for why that is not negotiable.
 */
export async function setMyChatLanguage(threadId: string, lang: string): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const res = await fetch("/api/chat/language", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ threadId, lang })
  });
  const payload = (await res.json().catch(() => ({}))) as { lang?: string; error?: string };
  if (!res.ok || !payload.lang) {
    throw new Error(payload.error || "Could not save the language.");
  }
  return payload.lang;
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

// ── Getting a second person in ─────────────────────────────────────────────
// Until 8/19 there was nothing here: threads were seeded by hand in SQL and
// an empty thread list was the end of the road for every other account. The
// two calls below are that road — mint a link, or walk in through one. Both
// go through routes for the same reason the send routes do: taos_lite_chat_*
// has no INSERT policy for a browser, deliberately.

/** The language this phone would speak in, for seeding a brand-new membership. */
function myPhoneLanguage(): string {
  return readStoredPair()?.[0] ?? "en";
}

export interface ChatInvite {
  /** The link to send or show as a QR. Minted once; nothing can read it back. */
  url: string;
  threadId: string;
  expiresAt: string;
  /** True when this call also created the thread — "start a chat", not "invite". */
  created: boolean;
}

/**
 * Mint a link.
 *
 * With a `threadId` this is "invite somebody into THIS chat" — the button on a
 * thread that is still one person. Without one it is "start a chat", which
 * always makes a NEW thread: Start is a button on the list now, and a list is
 * a thing you add to.
 */
export async function createChatInvite(threadId?: string): Promise<ChatInvite> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const res = await fetch("/api/chat/invite", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ lang: myPhoneLanguage(), ...(threadId ? { threadId } : {}) })
  });
  const payload = (await res.json().catch(() => ({}))) as Partial<ChatInvite> & { error?: string };
  if (!res.ok || !payload.url || !payload.threadId || !payload.expiresAt) {
    throw new Error(payload.error || "Could not create the invite link.");
  }
  return {
    url: payload.url,
    threadId: payload.threadId,
    expiresAt: payload.expiresAt,
    created: Boolean(payload.created)
  };
}

export interface ChatJoinResult {
  threadId: string;
  /** False when the link was already theirs — not an error, just nothing to do. */
  joined: boolean;
  message?: string;
}

export async function joinChatWithToken(inviteToken: string): Promise<ChatJoinResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const res = await fetch("/api/chat/join", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token: inviteToken, lang: myPhoneLanguage() })
  });
  const payload = (await res.json().catch(() => ({}))) as Partial<ChatJoinResult> & {
    error?: string;
  };
  if (!res.ok || !payload.threadId) {
    throw new Error(payload.error || "Could not open the invite.");
  }
  return {
    threadId: payload.threadId,
    joined: Boolean(payload.joined),
    message: payload.message
  };
}
