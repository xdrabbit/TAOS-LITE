import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import {
  CHAT_JOIN_FULL,
  inviteExpiry,
  inviteUrl,
  newInviteToken
} from "@/lib/chatInvite";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 15;

// Mints the link that lets a second person into a /chat thread — and, for
// somebody who has no thread at all, creates the thread on the way past.
//
// This is the route that did not exist. /chat's threads and memberships have
// SELECT policies and nothing else, and nothing anywhere in the app ever
// inserted one, so the only thread in the database is the one that was typed
// into the SQL editor by hand in July. Every other account reached /chat and
// was told it wasn't part of a chat, with no way to become part of one.
//
// Two calls in one because they are one intention. "Start a chat" and "invite
// the other person" are the same act from the user's side — a chat that is
// one person is not a chat yet — and splitting them would put a thread with
// nobody in it on screen between two taps.
//
// The token is minted here and returned once. Nothing reads it back out:
// there is no GET, no list, and no RLS policy on the invites table, so the
// only copy that matters is the one in the sheet the user is looking at. Tap
// invite again and you get a fresh link — see the delete below.
export async function POST(req: NextRequest): Promise<NextResponse> {
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

  const payload = (await req.json().catch(() => ({}))) as { lang?: string };
  // The creator's reading language, handed over from the phone's own pair so a
  // Spanish speaker's first thread is not silently in English. Validated the
  // same way /api/chat/language validates it — an unrecognized code would
  // reach the translation prompts as a bare string.
  const lang =
    typeof payload.lang === "string" && isSupportedLanguageCode(payload.lang)
      ? payload.lang
      : "en";

  // Which thread am I in? Same "first membership wins" rule lib/chat.ts draws
  // by, so the link is always for the thread on screen.
  const { data: mine, error: mineErr } = await supabaseAdmin
    .from("taos_lite_chat_members")
    .select("thread_id, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1);
  if (mineErr) {
    return NextResponse.json({ error: "Could not open your chat." }, { status: 502 });
  }

  let threadId = mine?.[0]?.thread_id as string | undefined;
  let created = false;

  if (!threadId) {
    const { data: thread, error: threadErr } = await supabaseAdmin
      .from("taos_lite_chat_threads")
      .insert({})
      .select("id")
      .single();
    if (threadErr || !thread) {
      return NextResponse.json({ error: "Could not start the chat." }, { status: 502 });
    }
    threadId = thread.id as string;
    created = true;

    const { error: memberErr } = await supabaseAdmin
      .from("taos_lite_chat_members")
      .insert({ thread_id: threadId, user_id: user.id, lang });
    if (memberErr) {
      // A thread nobody belongs to is invisible to RLS and would sit there
      // forever, so take it back out rather than leaving a stray row that the
      // next invite would then find and reuse.
      await supabaseAdmin.from("taos_lite_chat_threads").delete().eq("id", threadId);
      return NextResponse.json({ error: "Could not start the chat." }, { status: 502 });
    }
  } else {
    // An existing thread that is already two people has nowhere to put a third
    // (lib/chat.ts reads exactly one partner; the send route translates into
    // exactly one language). Say so instead of minting a link that could only
    // ever fail on the other person's phone.
    const { count, error: countErr } = await supabaseAdmin
      .from("taos_lite_chat_members")
      .select("user_id", { count: "exact", head: true })
      .eq("thread_id", threadId);
    if (countErr) {
      return NextResponse.json({ error: "Could not open your chat." }, { status: 502 });
    }
    if ((count ?? 0) >= 2) {
      return NextResponse.json({ error: CHAT_JOIN_FULL, threadId }, { status: 409 });
    }
  }

  // Only the newest link works. Somebody who taps invite twice has two QR
  // codes in the world and no way to tell which one they sent; retiring the
  // old one makes the answer "the one on your screen right now".
  await supabaseAdmin
    .from("taos_lite_chat_invites")
    .delete()
    .eq("thread_id", threadId)
    .is("accepted_at", null);

  const token = newInviteToken();
  const expiresAt = inviteExpiry();
  const { error: inviteErr } = await supabaseAdmin.from("taos_lite_chat_invites").insert({
    token,
    thread_id: threadId,
    created_by: user.id,
    expires_at: expiresAt
  });
  if (inviteErr) {
    return NextResponse.json({ error: "Could not create the invite link." }, { status: 502 });
  }

  return NextResponse.json({
    threadId,
    created,
    expiresAt,
    // Built from the request's Origin through the same allow-list that fences
    // Google sign-in, so a link minted on a preview points at that preview and
    // a link minted anywhere unrecognized points at production.
    url: inviteUrl(req.headers.get("origin"), token)
  });
}
