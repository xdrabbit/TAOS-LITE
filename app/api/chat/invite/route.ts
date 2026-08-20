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

// Mints the link that lets a second person into a /chat thread — and, when no
// thread is named, creates the thread on the way past.
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
// ── Which chat ─────────────────────────────────────────────────────────────
// `threadId` in the body is the difference, and it is the whole of the
// difference: naming one means "invite somebody into THIS chat", and omitting
// it means "start a new one". It used to be neither — the route found the
// FIRST thread the caller belonged to and re-used it forever, which is how an
// account ended up able to hold exactly one chat. Now that /chat has a list
// (lib/chatThreads.ts), Start is a button on that list and has to be able to
// make a second, third, fourth chat.
//
// So "start" always creates, even for somebody who already has a one-person
// thread waiting on a link. Folding a new Start back into that empty thread
// would look tidy and would retire a QR code somebody is still holding.
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

  const payload = (await req.json().catch(() => ({}))) as { lang?: string; threadId?: string };
  // The creator's reading language, handed over from the phone's own pair so a
  // Spanish speaker's first thread is not silently in English. Validated the
  // same way /api/chat/language validates it — an unrecognized code would
  // reach the translation prompts as a bare string.
  const lang =
    typeof payload.lang === "string" && isSupportedLanguageCode(payload.lang)
      ? payload.lang
      : "en";

  const wanted = typeof payload.threadId === "string" ? payload.threadId.trim() : "";
  let threadId: string;
  let created = false;

  if (wanted) {
    // Inviting into a chat I am already in. MY MEMBERSHIP is the permission —
    // read my own row rather than the thread's, so a threadId copied off
    // somebody else's screen mints nothing.
    const { data: mine, error: mineErr } = await supabaseAdmin
      .from("taos_lite_chat_members")
      .select("thread_id")
      .eq("user_id", user.id)
      .eq("thread_id", wanted)
      .maybeSingle();
    if (mineErr) {
      return NextResponse.json({ error: "Could not open your chat." }, { status: 502 });
    }
    if (!mine) {
      // Same answer /api/chat/send and /api/chat/language give, for the same
      // reason: not a member is not a 404, it is a refusal.
      return NextResponse.json({ error: "You are not part of this chat." }, { status: 403 });
    }
    threadId = wanted;

    // A thread that is already two people has nowhere to put a third (the send
    // route translates into exactly one partner language). Say so instead of
    // minting a link that could only ever fail on the other person's phone.
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
  } else {
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
      // forever — a row in the database that no list can ever show and no
      // invite can ever reach. Take it back out.
      await supabaseAdmin.from("taos_lite_chat_threads").delete().eq("id", threadId);
      return NextResponse.json({ error: "Could not start the chat." }, { status: 502 });
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
