import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import {
  CHAT_LIST_SOMEONE,
  partnerDisplayName,
  sortThreads,
  threadPreview,
  type ChatPreviewMessage,
  type ChatThreadSummary
} from "@/lib/chatThreads";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 15;

// Every chat this account is in — the list /chat opens on once there is more
// than one of them.
//
// ── Why a route, when RLS already scopes the tables ────────────────────────
// The rest of /chat's reads go straight through supabase-js: the members and
// messages policies are `taos_lite_is_chat_member(thread_id)`, so a browser
// can already list its own threads and their messages without a server in the
// middle. One thing it cannot do is put a NAME on a row. The other member's
// display name lives in auth.users, which no anon key may read and which
// should stay that way — an app that let one signed-in account enumerate
// another's email is a directory, and /chat's whole shape is the argument
// against having one.
//
// So this route reads exactly two things with the service role: my
// memberships, and the profile of whoever else is in each of those threads.
// It never reads a thread the caller is not in — every query below is rooted
// in the caller's own membership rows, which is the same fence RLS would
// draw, written out by hand because the service role bypasses it.
//
// ── What it does NOT do ────────────────────────────────────────────────────
// No writes of any kind. GET only, and nothing on this path creates a thread,
// a membership, or an invite.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }
  if (!hasServiceRoleKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY." },
      { status: 500 }
    );
  }

  // My memberships. The root of everything below — a thread is in this answer
  // only because one of these rows says so.
  const { data: mine, error: mineErr } = await supabaseAdmin
    .from("taos_lite_chat_members")
    .select("thread_id, lang, created_at")
    .eq("user_id", user.id);
  if (mineErr) {
    return NextResponse.json({ error: "Could not open your chats." }, { status: 502 });
  }
  const threadIds = (mine ?? []).map((m) => m.thread_id as string);
  if (!threadIds.length) {
    // Not an error and not an empty screen: the shell draws "Start a chat".
    return NextResponse.json({ myUserId: user.id, threads: [] });
  }

  // Everybody in those threads, so the partner is a lookup rather than a
  // query per row. Two members per thread, so this is at most 2n rows.
  const { data: everyone, error: everyoneErr } = await supabaseAdmin
    .from("taos_lite_chat_members")
    .select("thread_id, user_id, lang")
    .in("thread_id", threadIds);
  if (everyoneErr) {
    return NextResponse.json({ error: "Could not open your chats." }, { status: 502 });
  }

  const { data: threadRows, error: threadErr } = await supabaseAdmin
    .from("taos_lite_chat_threads")
    .select("id, created_at")
    .in("id", threadIds);
  if (threadErr) {
    return NextResponse.json({ error: "Could not open your chats." }, { status: 502 });
  }
  const createdAt = new Map(
    (threadRows ?? []).map((t) => [t.id as string, t.created_at as string])
  );

  // The last line of each thread, one query per thread against
  // taos_lite_chat_messages (thread_id, created_at DESC) — the index that has
  // been there since tier 1. A single ordered query over all threads at once
  // would be one round trip and would let one chatty thread starve a quiet
  // one out of its own preview.
  const lastMessages = await Promise.all(
    threadIds.map(async (id) => {
      const { data } = await supabaseAdmin
        .from("taos_lite_chat_messages")
        .select("sender_id, kind, body, body_translated, created_at")
        .eq("thread_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return [id, (data ?? null) as (ChatPreviewMessage & { created_at: string }) | null] as const;
    })
  );
  const lastByThread = new Map(lastMessages);

  // The other person's name, off their own account. getUserById one at a time
  // rather than listUsers(): the list is paginated over every account that has
  // ever signed up, and this route has no business seeing any of them except
  // the handful sharing a thread with the caller.
  const partnerIds = Array.from(
    new Set(
      (everyone ?? [])
        .filter((m) => m.user_id !== user.id)
        .map((m) => m.user_id as string)
    )
  );
  const names = new Map<string, string>();
  await Promise.all(
    partnerIds.map(async (id) => {
      // A profile that will not load is a nameless row, never a failed list:
      // the chat and its history are fine, and "Someone · Alguien" is a true
      // label. What it must NOT become is null — null means "nobody has joined
      // this thread yet", which is a different row and a different sentence.
      try {
        const { data } = await supabaseAdmin.auth.admin.getUserById(id);
        names.set(id, partnerDisplayName(data?.user ?? null) ?? CHAT_LIST_SOMEONE);
      } catch {
        names.set(id, CHAT_LIST_SOMEONE);
      }
    })
  );

  const threads: ChatThreadSummary[] = threadIds.map((threadId) => {
    const me = (mine ?? []).find((m) => m.thread_id === threadId);
    const partner = (everyone ?? []).find(
      (m) => m.thread_id === threadId && m.user_id !== user.id
    );
    const last = lastByThread.get(threadId) ?? null;
    return {
      threadId,
      // Per-membership, and this is where that stops being a schema detail:
      // two rows of this list can be two different reading languages, and the
      // preview below is resolved with the one from THIS thread.
      myLang: (me?.lang as string) ?? "en",
      partnerLang: (partner?.lang as string | undefined) ?? null,
      partnerName: partner ? names.get(partner.user_id as string) ?? CHAT_LIST_SOMEONE : null,
      preview: threadPreview(last, user.id),
      // An empty thread still has to sort somewhere, and the moment it was
      // started is the honest answer — it is the only thing that happened.
      updatedAt: last?.created_at ?? createdAt.get(threadId) ?? new Date(0).toISOString()
    };
  });

  return NextResponse.json({ myUserId: user.id, threads: sortThreads(threads) });
}
